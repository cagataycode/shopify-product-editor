import { render } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import { useState, useMemo, useEffect } from 'preact/hooks';

const MAX_ROWS = 250;
const BATCH_SIZE = 250;

type FieldKey = 'title' | 'description' | 'vendor' | 'productType' | 'status' | 'tags';

interface FieldDef {
  key: FieldKey;
  label: string;
  input: 'text' | 'textarea' | 'status';
}

const FIELD_DEFS: FieldDef[] = [
  { key: 'title', label: 'Title', input: 'text' },
  { key: 'description', label: 'Description', input: 'textarea' },
  { key: 'vendor', label: 'Vendor', input: 'text' },
  { key: 'productType', label: 'Product type', input: 'text' },
  { key: 'status', label: 'Status', input: 'status' },
  { key: 'tags', label: 'Tags', input: 'text' },
];

const IMAGE_LABEL = 'Image';
const INVENTORY_LABEL = 'Inventory quantity';
const WEIGHT_LABEL = 'Weight';

const WEIGHT_UNITS: { value: string; label: string }[] = [
  { value: 'KILOGRAMS', label: 'Kilograms' },
  { value: 'GRAMS', label: 'Grams' },
  { value: 'POUNDS', label: 'Pounds' },
  { value: 'OUNCES', label: 'Ounces' },
];

interface LocationOption {
  id: string;
  name: string;
}

interface MetafieldDefinition {
  id: string;
  name: string;
  namespace: string;
  key: string;
  typeName: string;
  choices: string[] | null;
}

interface MetafieldCell {
  value: string;
  touched: boolean;
}

function emptyMetafieldCell(): MetafieldCell {
  return { value: '', touched: false };
}

function isListType(typeName: string): boolean {
  return typeName.startsWith('list.');
}

// True for list metafields that restrict values to a fixed set of choices.
function isChoiceRestrictedList(def: MetafieldDefinition): boolean {
  return def.choices !== null && def.choices.length > 0 && isListType(def.typeName);
}

function metafieldInputKind(
  def: MetafieldDefinition,
):
  | 'select'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'integer'
  | 'decimal'
  | 'textarea'
  | 'list'
  | 'text' {
  if (isListType(def.typeName)) return 'list';
  if (def.choices && def.choices.length > 0) return 'select';
  switch (def.typeName) {
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'date_time':
      return 'datetime';
    case 'number_integer':
      return 'integer';
    case 'number_decimal':
      return 'decimal';
    case 'multi_line_text_field':
    case 'json':
      return 'textarea';
    default:
      return 'text';
  }
}

// Convert a list metafield's newline-separated cell value into the JSON array
// string Shopify expects (e.g. ["a","b"]).
function listCellToJson(raw: string): string {
  const items = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return JSON.stringify(items);
}

// Strip HTML tags to plain text for display only.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface FileResult {
  id: string;
  sourceUrl: string;
  thumbnailUrl: string;
  alt: string;
}

interface ImageSelection {
  sourceUrl: string;
  thumbnailUrl: string;
  alt: string;
}

interface RowImageState {
  searchTerm: string;
  searching: boolean;
  results: FileResult[];
  searched: boolean;
  error: string | null;
  selected: ImageSelection | null;
}

function emptyImageState(): RowImageState {
  return {
    searchTerm: '',
    searching: false,
    results: [],
    searched: false,
    error: null,
    selected: null,
  };
}

function emptyRow(): GridRow {
  return {
    id: '',
    title: '',
    values: emptyValues(),
    image: emptyImageState(),
    metafields: {},
    inventoryQty: '',
    weight: '',
  };
}

function formatWeight(value: number | null, unit: string): string {
  if (value === null || Number.isNaN(value)) return 'none';
  return `${value} ${unit}`;
}

// Shared loading / error / retry UI used by the metafield-definitions and
// locations lazy loaders. When not loading and not errored, renders children.
function LoadingSection(props: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  loadingLabel: string;
  errorHeading: string;
  children?: ComponentChildren;
}): VNode {
  if (props.loading) {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-spinner accessibilityLabel={props.loadingLabel} />
        <s-text>{props.loadingLabel}</s-text>
      </s-stack>
    );
  }
  if (props.error) {
    return (
      <s-banner tone="critical" heading={props.errorHeading}>
        <s-stack gap="small">
          <s-paragraph>{props.error}</s-paragraph>
          <s-stack direction="inline" justifyContent="start">
            <s-button onClick={props.onRetry}>Retry</s-button>
          </s-stack>
        </s-stack>
      </s-banner>
    );
  }
  return <>{props.children}</>;
}

interface GridRow {
  id: string;
  title: string;
  values: Record<FieldKey, string>;
  image: RowImageState;
  metafields: Record<string, MetafieldCell>;
  inventoryQty: string;
  weight: string;
}

interface FetchedProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: string;
  tags: string[];
  currentImageUrl: string;
  metafieldValues: Record<string, string>;
  inventoryItemId: string;
  variantCount: number;
  weightValue: number | null;
  weightUnit: string;
}

type DuplicateRole = 'none' | 'winner' | 'overridden';

interface PreviewRow {
  key: string;
  productGid: string;
  productTitle: string;
  field: FieldKey | 'image' | 'metafield' | 'inventory' | 'weight';
  fieldLabel: string;
  currentValue: string;
  newValue: string;
  newThumbnailUrl: string | null;
  imageSourceUrl: string | null;
  metafieldNamespace: string | null;
  metafieldKey: string | null;
  metafieldType: string | null;
  duplicateRole: DuplicateRole;
  inventoryItemId: string | null;
  currentInventoryQty: number | null;
  newInventoryQty: number | null;
  newWeightValue: number | null;
  variantCount: number;
  checked: boolean;
}

type ResultStatus = 'success' | 'failed' | 'partial';

interface ResultRow {
  productTitle: string;
  status: ResultStatus;
  error: string;
}

type Step = 'select' | 'grid' | 'preview' | 'results';

function emptyValues(): Record<FieldKey, string> {
  return {
    title: '',
    description: '',
    vendor: '',
    productType: '',
    status: '',
    tags: '',
  };
}

function normalizeToGid(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('gid://shopify/Product/')) return trimmed;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/Product/${trimmed}`;
  return null;
}

function displayId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('gid://shopify/Product/')) {
    return trimmed.split('/').pop() || trimmed;
  }
  return trimmed;
}

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Split pasted text into per-row values. Single-line fields split on every
// newline; multi-line fields (Description, textarea/JSON/list metafields) split
// only on a line containing solely hyphens (---), so blank lines and other
// internal newlines within a value are preserved.
function splitPasteValues(raw: string, multiLine: boolean): string[] {
  if (multiLine) {
    return raw
      .split(/\r?\n[ \t]*-{3,}[ \t]*(?:\r?\n|$)/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottleError(
  err: unknown,
  graphqlErrors?: { message?: string; extensions?: { code?: string } }[],
): boolean {
  const matchesText = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes('throttled') ||
      lower.includes('rate limit') ||
      lower.includes('too many requests')
    );
  };

  if (graphqlErrors && graphqlErrors.length > 0) {
    for (const e of graphqlErrors) {
      if (e.extensions?.code && e.extensions.code.toUpperCase() === 'THROTTLED') return true;
      if (e.message && matchesText(e.message)) return true;
    }
  }

  if (err) {
    const status = err as { status?: number; statusCode?: number; response?: { status?: number } };
    if (status.status === 429 || status.statusCode === 429 || status.response?.status === 429) {
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (matchesText(message)) return true;
  }

  return false;
}

function Extension() {
  const [step, setStep] = useState<Step>('select');
  const [selectedFields, setSelectedFields] = useState<Record<FieldKey, boolean>>({
    title: false,
    description: false,
    vendor: false,
    productType: false,
    status: false,
    tags: false,
  });

  const [rows, setRows] = useState<GridRow[]>([emptyRow()]);
  const [editImage, setEditImage] = useState(false);
  const [editInventory, setEditInventory] = useState(false);
  const [editWeight, setEditWeight] = useState(false);

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [weightUnit, setWeightUnit] = useState('KILOGRAMS');
  const [inventoryPaste, setInventoryPaste] = useState('');
  const [weightPaste, setWeightPaste] = useState('');
  const [fillValues, setFillValues] = useState<Record<string, string>>({});

  function setFillValue(key: string, value: string) {
    setFillValues((prev) => ({ ...prev, [key]: value }));
  }

  // Fill a whole column: write `value` into every row that has a non-blank
  // product ID. Blank fill values are a no-op. Blank-ID rows are left unchanged.
  function fillColumn(
    key: string,
    value: string,
    target: 'standard' | 'metafield' | 'inventory' | 'weight',
  ) {
    if (value.trim() === '') return;
    setRows((prev) =>
      prev.map((row) => {
        if (row.id.trim() === '') return row;
        if (target === 'standard') {
          return { ...row, values: { ...row.values, [key]: value } };
        }
        if (target === 'metafield') {
          return {
            ...row,
            metafields: { ...row.metafields, [key]: { value, touched: true } },
          };
        }
        if (target === 'inventory') {
          return { ...row, inventoryQty: value };
        }
        return { ...row, weight: value };
      }),
    );
  }

  async function loadLocations() {
    setLocationsLoading(true);
    setLocationsError(null);
    const query = `query GetActiveLocations {
      locations(first: 50, includeInactive: false) {
        nodes { id name isActive }
      }
    }`;
    try {
      const { data, errors } = await shopify.query(query);
      if (errors && errors.length > 0) {
        setLocationsError(errors.map((e: { message: string }) => e.message).join(', '));
        setLocationsLoading(false);
        setLocationsLoaded(true);
        return;
      }
      const nodes = (data?.locations?.nodes || []) as {
        id: string;
        name: string;
        isActive?: boolean;
      }[];
      const active = nodes
        .filter((n) => n.isActive !== false)
        .map((n) => ({ id: n.id, name: n.name }));
      setLocations(active);
      if (active.length > 0) setSelectedLocationId((prev) => prev || active[0].id);
      setLocationsLoading(false);
      setLocationsLoaded(true);
    } catch (err) {
      setLocationsError(err instanceof Error ? err.message : 'Failed to load locations');
      setLocationsLoading(false);
      setLocationsLoaded(true);
    }
  }

  useEffect(() => {
    if (editInventory && !locationsLoaded && !locationsLoading) {
      loadLocations();
    }
  }, [editInventory, locationsLoaded, locationsLoading]);

  const selectedLocationName = locations.find((l) => l.id === selectedLocationId)?.name || '';

  const [definitions, setDefinitions] = useState<MetafieldDefinition[]>([]);
  const [definitionsLoading, setDefinitionsLoading] = useState(false);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [definitionsLoaded, setDefinitionsLoaded] = useState(false);
  const [selectedDefinitions, setSelectedDefinitions] = useState<Record<string, boolean>>({});
  const [pastedMetafields, setPastedMetafields] = useState<Record<string, boolean>>({});
  const [metafieldPaste, setMetafieldPaste] = useState<Record<string, string>>({});

  const [idPaste, setIdPaste] = useState('');
  const [columnPaste, setColumnPaste] = useState<Record<FieldKey, string>>(emptyValues());

  const [lookupError, setLookupError] = useState<string | null>(null);
  const [pastedColumns, setPastedColumns] = useState<Record<FieldKey, boolean>>({
    title: false,
    description: false,
    vendor: false,
    productType: false,
    status: false,
    tags: false,
  });
  const [invalidIds, setInvalidIds] = useState<string[]>([]);
  const [duplicateIds, setDuplicateIds] = useState<string[]>([]);
  const [countWarnings, setCountWarnings] = useState<string[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [pasteOverflowWarnings, setPasteOverflowWarnings] = useState<Record<string, string>>({});
  const [pasteValidationWarnings, setPasteValidationWarnings] = useState<Record<string, string>>(
    {},
  );
  const [validating, setValidating] = useState(false);

  const [productMap, setProductMap] = useState<Record<string, FetchedProduct>>({});
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);

  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);

  const chosenFields = useMemo(
    () => FIELD_DEFS.filter((f) => selectedFields[f.key]),
    [selectedFields],
  );

  const chosenDefinitions = useMemo(
    () => definitions.filter((d) => selectedDefinitions[d.id]),
    [definitions, selectedDefinitions],
  );

  const anyFieldSelected = chosenFields.length > 0;

  async function loadDefinitions() {
    setDefinitionsLoading(true);
    setDefinitionsError(null);
    const query = `query GetProductMetafieldDefinitions {
      metafieldDefinitions(ownerType: PRODUCT, first: 250) {
        nodes {
          id
          name
          namespace
          key
          type { name }
          validations { name value }
        }
      }
    }`;
    try {
      const { data, errors } = await shopify.query(query);
      if (errors && errors.length > 0) {
        setDefinitionsError(errors.map((e: { message: string }) => e.message).join(', '));
        setDefinitionsLoading(false);
        setDefinitionsLoaded(true);
        return;
      }
      const nodes = (data?.metafieldDefinitions?.nodes || []) as {
        id: string;
        name: string;
        namespace: string;
        key: string;
        type?: { name?: string };
        validations?: { name: string; value: string }[];
      }[];
      const parsed: MetafieldDefinition[] = nodes.map((n) => {
        let choices: string[] | null = null;
        const choiceValidation = (n.validations || []).find((v) => v.name === 'choices');
        if (choiceValidation) {
          try {
            const arr = JSON.parse(choiceValidation.value);
            if (Array.isArray(arr)) choices = arr.map((c) => String(c));
          } catch {
            choices = null;
          }
        }
        return {
          id: n.id,
          name: n.name,
          namespace: n.namespace,
          key: n.key,
          typeName: n.type?.name || 'single_line_text_field',
          choices,
        };
      });
      setDefinitions(parsed);
      setDefinitionsLoading(false);
      setDefinitionsLoaded(true);
    } catch (err) {
      setDefinitionsError(
        err instanceof Error ? err.message : 'Failed to load metafield definitions',
      );
      setDefinitionsLoading(false);
      setDefinitionsLoaded(true);
    }
  }

  useEffect(() => {
    if (step === 'select' && !definitionsLoaded && !definitionsLoading) {
      loadDefinitions();
    }
  }, [step, definitionsLoaded, definitionsLoading]);

  // After preview validation fills productMap, backfill row titles for rows that
  // don't yet have a title (e.g. rows added via ID paste).
  useEffect(() => {
    if (Object.keys(productMap).length === 0) return;
    setRows((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r.title !== '') return r;
        const gid = normalizeToGid(r.id);
        if (gid && productMap[gid]) {
          changed = true;
          return { ...r, title: productMap[gid].title };
        }
        return r;
      });
      return changed ? next : prev;
    });
  }, [productMap]);

  // Recompute paste overflow/validation warnings whenever the rows or the set of
  // chosen fields change, so warnings stay accurate as rows are added/edited.
  useEffect(() => {
    const overflow: Record<string, string> = {};
    const addOverflow = (fieldKey: string, label: string, getValue: (r: GridRow) => string) => {
      const count = rows.filter((r) => getValue(r).trim() !== '' && r.id.trim() === '').length;
      if (count > 0) {
        overflow[fieldKey] =
          `${count} pasted value(s) for ${label} have no matching product ID and were not applied. Add product IDs to those rows or paste fewer values.`;
      }
    };
    for (const f of chosenFields) {
      if (pastedColumns[f.key]) addOverflow(f.key, f.label, (r) => r.values[f.key]);
    }
    for (const d of chosenDefinitions) {
      if (pastedMetafields[d.id]) addOverflow(d.id, d.name, (r) => r.metafields[d.id]?.value || '');
    }
    if (editInventory) addOverflow('__inventory', INVENTORY_LABEL, (r) => r.inventoryQty);
    if (editWeight) addOverflow('__weight', WEIGHT_LABEL, (r) => r.weight);
    setPasteOverflowWarnings(overflow);

    const validation: Record<string, string> = {};
    if (pastedColumns.status) {
      const allowedStatus = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
      const badRows: number[] = [];
      const badValues: string[] = [];
      rows.forEach((r, i) => {
        const val = r.values.status.trim();
        if (val === '') return;
        if (!allowedStatus.includes(val.toUpperCase())) {
          badRows.push(i + 1);
          badValues.push(val);
        }
      });
      if (badRows.length > 0) {
        validation['status'] =
          `Row(s) ${badRows.join(', ')} had unrecognized Status values (${badValues.join(', ')}) that were cleared. Allowed values are ACTIVE, DRAFT, ARCHIVED.`;
      }
    }
    for (const d of chosenDefinitions) {
      if (!pastedMetafields[d.id]) continue;
      const kind = metafieldInputKind(d);
      const choices = d.choices || [];
      if (kind !== 'boolean' && kind !== 'select' && !isChoiceRestrictedList(d)) continue;
      const badRows: number[] = [];
      const badValues: string[] = [];
      rows.forEach((r, i) => {
        const rawVal = (r.metafields[d.id]?.value || '').trim();
        if (rawVal === '') return;
        if (kind === 'boolean') {
          if (!['true', 'false'].includes(rawVal.toLowerCase())) {
            badRows.push(i + 1);
            badValues.push(rawVal);
          }
        } else if (kind === 'select') {
          if (!choices.some((c) => c.toLowerCase() === rawVal.toLowerCase())) {
            badRows.push(i + 1);
            badValues.push(rawVal);
          }
        } else {
          const items = rawVal.split(/\r?\n/).map((l) => l.trim());
          let rowBad = false;
          for (const item of items) {
            if (item === '') continue;
            if (!choices.some((c) => c.toLowerCase() === item.toLowerCase())) {
              rowBad = true;
              badValues.push(item);
            }
          }
          if (rowBad) badRows.push(i + 1);
        }
      });
      if (badRows.length > 0) {
        const allowed = kind === 'boolean' ? 'true, false' : choices.join(', ');
        validation[d.id] =
          `Row(s) ${badRows.join(', ')} had unrecognized ${d.name} values (${badValues.join(', ')}) that were cleared. Allowed values are ${allowed}.`;
      }
    }
    setPasteValidationWarnings(validation);
  }, [
    rows,
    chosenFields,
    chosenDefinitions,
    editInventory,
    editWeight,
    pastedColumns,
    pastedMetafields,
  ]);

  const nonBlankIdCount = useMemo(() => rows.filter((r) => r.id.trim() !== '').length, [rows]);

  const anyFieldValueEntered = useMemo(() => {
    const anyText = rows.some((r) => chosenFields.some((f) => r.values[f.key].trim() !== ''));
    const anyImage = editImage && rows.some((r) => r.image.selected !== null);
    const anyMeta = rows.some((r) =>
      chosenDefinitions.some((d) => {
        const cell = r.metafields[d.id];
        return cell && cell.touched && cell.value.trim() !== '';
      }),
    );
    const anyInv = editInventory && rows.some((r) => r.inventoryQty.trim() !== '');
    const anyWeight = editWeight && rows.some((r) => r.weight.trim() !== '');
    return anyText || anyImage || anyMeta || anyInv || anyWeight;
  }, [rows, chosenFields, editImage, chosenDefinitions, editInventory, editWeight]);

  const excessRows = rows.length > MAX_ROWS;

  function toggleField(key: FieldKey, checked: boolean) {
    setSelectedFields((prev) => ({ ...prev, [key]: checked }));
  }

  function toggleDefinition(id: string, checked: boolean) {
    setSelectedDefinitions((prev) => ({ ...prev, [id]: checked }));
  }

  function updateRowInventory(index: number, value: string) {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], inventoryQty: value };
      return next;
    });
  }

  function updateRowWeight(index: number, value: string) {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], weight: value };
      return next;
    });
  }

  // Count rows that have a non-blank value for a column but a blank product ID,
  // and record an overflow warning for the field key (or clear it when none).
  function recordOverflow(
    fieldKey: string,
    fieldLabel: string,
    nextRows: GridRow[],
    getValue: (r: GridRow) => string,
  ) {
    const overflow = nextRows.filter((r) => getValue(r).trim() !== '' && r.id.trim() === '').length;
    setPasteOverflowWarnings((prev) => {
      const updated = { ...prev };
      if (overflow > 0) {
        updated[fieldKey] =
          `${overflow} pasted value(s) for ${fieldLabel} have no matching product ID and were not applied. Add product IDs to those rows or paste fewer values.`;
      } else {
        delete updated[fieldKey];
      }
      return updated;
    });
  }

  function applyInventoryPaste() {
    setPasteOverflowWarnings((prev) => {
      const updated = { ...prev };
      delete updated['__inventory'];
      return updated;
    });
    const lines = inventoryPaste.split(/\r?\n/).map((l) => l.trim());
    const cleaned = lines.filter((l) => l !== '');
    setRows((prev) => {
      const next: GridRow[] = [];
      const count = Math.max(cleaned.length, prev.length);
      for (let i = 0; i < count; i++) {
        const existing = prev[i] || emptyRow();
        next.push({
          ...existing,
          inventoryQty: i < cleaned.length ? cleaned[i] : existing.inventoryQty,
        });
      }
      recordOverflow('__inventory', INVENTORY_LABEL, next, (r) => r.inventoryQty);
      return next;
    });
    setInventoryPaste('');
  }

  function applyWeightPaste() {
    setPasteOverflowWarnings((prev) => {
      const updated = { ...prev };
      delete updated['__weight'];
      return updated;
    });
    const lines = weightPaste.split(/\r?\n/).map((l) => l.trim());
    const cleaned = lines.filter((l) => l !== '');
    setRows((prev) => {
      const next: GridRow[] = [];
      const count = Math.max(cleaned.length, prev.length);
      for (let i = 0; i < count; i++) {
        const existing = prev[i] || emptyRow();
        next.push({ ...existing, weight: i < cleaned.length ? cleaned[i] : existing.weight });
      }
      recordOverflow('__weight', WEIGHT_LABEL, next, (r) => r.weight);
      return next;
    });
    setWeightPaste('');
  }

  function updateRowMetafield(index: number, defId: string, value: string) {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = {
        ...next[index],
        metafields: { ...next[index].metafields, [defId]: { value, touched: true } },
      };
      return next;
    });
  }

  function applyMetafieldPaste(defId: string) {
    setPastedMetafields((prev) => ({ ...prev, [defId]: true }));
    setPasteOverflowWarnings((prev) => {
      const updated = { ...prev };
      delete updated[defId];
      return updated;
    });
    setPasteValidationWarnings((prev) => {
      const updated = { ...prev };
      delete updated[defId];
      return updated;
    });
    const raw = metafieldPaste[defId] || '';
    const def = definitions.find((d) => d.id === defId);
    const kind = def ? metafieldInputKind(def) : 'text';
    const isMultiLine = ['textarea', 'json', 'list'].includes(kind);
    const cleaned = splitPasteValues(raw, isMultiLine);
    setRows((prev) => {
      const next: GridRow[] = [];
      const count = Math.max(cleaned.length, prev.length);
      for (let i = 0; i < count; i++) {
        const existing = prev[i];
        const baseMeta = existing ? { ...existing.metafields } : {};
        if (i < cleaned.length) {
          baseMeta[defId] = { value: cleaned[i], touched: true };
        }
        next.push({
          ...(existing || emptyRow()),
          id: existing ? existing.id : '',
          values: existing ? existing.values : emptyValues(),
          image: existing ? existing.image : emptyImageState(),
          metafields: baseMeta,
        });
      }
      // Validate restricted-value metafields, normalizing valid values to their
      // exact casing and clearing (blanking) unrecognized values.
      if (def && (kind === 'boolean' || kind === 'select' || isChoiceRestrictedList(def))) {
        const badRows: number[] = [];
        const badValues: string[] = [];
        const choices = def.choices || [];
        for (let i = 0; i < next.length; i++) {
          const cell = next[i].metafields[defId];
          const rawVal = (cell?.value || '').trim();
          if (rawVal === '') continue;
          if (kind === 'boolean') {
            const lower = rawVal.toLowerCase();
            if (lower === 'true' || lower === 'false') {
              next[i] = {
                ...next[i],
                metafields: { ...next[i].metafields, [defId]: { value: lower, touched: true } },
              };
            } else {
              badRows.push(i + 1);
              badValues.push(rawVal);
              next[i] = {
                ...next[i],
                metafields: { ...next[i].metafields, [defId]: { value: '', touched: true } },
              };
            }
          } else if (kind === 'select') {
            const match = choices.find((c) => c.toLowerCase() === rawVal.toLowerCase());
            if (match) {
              next[i] = {
                ...next[i],
                metafields: { ...next[i].metafields, [defId]: { value: match, touched: true } },
              };
            } else {
              badRows.push(i + 1);
              badValues.push(rawVal);
              next[i] = {
                ...next[i],
                metafields: { ...next[i].metafields, [defId]: { value: '', touched: true } },
              };
            }
          } else {
            // Choice-restricted list: validate each line (item) against choices,
            // normalize matches, drop unrecognized items.
            const items = rawVal.split(/\r?\n/).map((l) => l.trim());
            const kept: string[] = [];
            let removedAny = false;
            for (const item of items) {
              if (item === '') continue;
              const match = choices.find((c) => c.toLowerCase() === item.toLowerCase());
              if (match) {
                kept.push(match);
              } else {
                removedAny = true;
                badValues.push(item);
              }
            }
            if (removedAny) badRows.push(i + 1);
            next[i] = {
              ...next[i],
              metafields: {
                ...next[i].metafields,
                [defId]: { value: kept.join('\n'), touched: true },
              },
            };
          }
        }
        setPasteValidationWarnings((prev) => {
          const updated = { ...prev };
          if (badRows.length > 0) {
            const allowed = kind === 'boolean' ? 'true, false' : choices.join(', ');
            updated[defId] =
              `Row(s) ${badRows.join(', ')} had unrecognized ${def.name} values (${badValues.join(', ')}) that were cleared. Allowed values are ${allowed}.`;
          } else {
            delete updated[defId];
          }
          return updated;
        });
      }
      recordOverflow(
        defId,
        def ? def.name : 'Metafield',
        next,
        (r) => r.metafields[defId]?.value || '',
      );
      return next;
    });
    setMetafieldPaste((prev) => ({ ...prev, [defId]: '' }));
  }

  function clearValidationState() {
    setInvalidIds([]);
    setDuplicateIds([]);
    setLookupError(null);
  }

  function updateRowId(index: number, value: string) {
    clearValidationState();
    setRows((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], id: value, title: '' };
      return next;
    });
  }

  // Open the Shopify resource picker and add selected products as rows.
  async function browseProducts() {
    clearValidationState();
    const picker = (
      shopify as unknown as {
        resourcePicker: (options: {
          type: string;
          multiple: boolean;
          filter: { variants: boolean; draft: boolean; archived: boolean };
        }) => Promise<{ id?: string; title?: string }[] | undefined>;
      }
    ).resourcePicker;
    const selected = await picker({
      type: 'product',
      multiple: true,
      filter: { variants: false, draft: false, archived: false },
    });
    if (!selected || !Array.isArray(selected)) return;

    setRows((prev) => {
      const next = prev.slice();
      for (const item of selected as { id?: string; title?: string }[]) {
        if (!item || typeof item.id !== 'string') continue;
        const normalizedGid = normalizeToGid(item.id);
        if (!normalizedGid) continue;
        const alreadyPresent = next.some((r) => normalizeToGid(r.id) === normalizedGid);
        if (alreadyPresent) continue;
        const title = item.title || '';
        const emptyIndex = next.findIndex((r) => r.id.trim() === '');
        if (emptyIndex >= 0) {
          next[emptyIndex] = { ...next[emptyIndex], id: normalizedGid, title };
        } else {
          next.push({ ...emptyRow(), id: normalizedGid, title });
        }
      }
      return next;
    });
  }

  function updateRowValue(index: number, key: FieldKey, value: string) {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = {
        ...next[index],
        values: { ...next[index].values, [key]: value },
      };
      return next;
    });
  }

  function updateRowImage(index: number, patch: Partial<RowImageState>) {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], image: { ...next[index].image, ...patch } };
      return next;
    });
  }

  async function searchRowFiles(index: number, term: string) {
    const trimmed = term.trim();
    if (trimmed === '') return;
    updateRowImage(index, { searching: true, error: null, searched: true });

    const query = `query SearchFiles($searchTerm: String!) {
      files(first: 20, query: $searchTerm) {
        nodes {
          ... on MediaImage {
            id
            alt
            image { url }
            preview { image { url(transform: { maxWidth: 100, maxHeight: 100 }) } }
          }
        }
      }
    }`;

    const hasQualifier = /:/.test(trimmed);
    const searchTerm = hasQualifier ? trimmed : `filename:*${trimmed}*`;

    try {
      const { data, errors } = await shopify.query(query, {
        variables: { searchTerm },
      });
      if (errors && errors.length > 0) {
        updateRowImage(index, {
          searching: false,
          error: errors.map((e: { message: string }) => e.message).join(', '),
          results: [],
        });
        return;
      }
      const nodes = (data?.files?.nodes || []) as {
        id?: string;
        alt?: string;
        image?: { url?: string };
        preview?: { image?: { url?: string } };
      }[];
      const parsed: FileResult[] = [];
      for (const node of nodes) {
        if (node && node.id && node.image?.url) {
          parsed.push({
            id: node.id,
            sourceUrl: node.image.url,
            thumbnailUrl: node.preview?.image?.url || node.image.url,
            alt: node.alt || '',
          });
        }
      }
      updateRowImage(index, { searching: false, results: parsed, error: null });
    } catch (err) {
      updateRowImage(index, {
        searching: false,
        error: err instanceof Error ? err.message : 'Search failed',
        results: [],
      });
    }
  }

  function selectRowImage(index: number, file: FileResult) {
    updateRowImage(index, {
      selected: {
        sourceUrl: file.sourceUrl,
        thumbnailUrl: file.thumbnailUrl,
        alt: file.alt,
      },
    });
  }

  function clearRowImage(index: number) {
    updateRowImage(index, { selected: null });
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((prev) => {
      if (prev.length === 1) return [emptyRow()];
      return prev.filter((_, i) => i !== index);
    });
  }

  function applyIdPaste() {
    clearValidationState();
    const lines = idPaste.split(/\r?\n/).map((l) => l.trim());
    const cleaned = lines.filter((l) => l !== '');
    setRows((prev) => {
      const next: GridRow[] = [];
      const count = Math.max(cleaned.length, prev.length);
      for (let i = 0; i < count; i++) {
        const existing = prev[i];
        next.push({
          ...(existing || emptyRow()),
          id: i < cleaned.length ? cleaned[i] : existing ? existing.id : '',
          values: existing ? existing.values : emptyValues(),
          image: existing ? existing.image : emptyImageState(),
          metafields: existing ? existing.metafields : {},
        });
      }
      return next;
    });
    setIdPaste('');
  }

  function applyColumnPaste(key: FieldKey) {
    setPastedColumns((prev) => ({ ...prev, [key]: true }));
    setPasteOverflowWarnings((prev) => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
    setPasteValidationWarnings((prev) => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
    const raw = columnPaste[key];
    const def = FIELD_DEFS.find((f) => f.key === key);
    const fieldLabel = def ? def.label : key;
    const isMultiLine = def?.input === 'textarea';
    const cleaned = splitPasteValues(raw, isMultiLine);
    setRows((prev) => {
      const next: GridRow[] = [];
      const count = Math.max(cleaned.length, prev.length);
      for (let i = 0; i < count; i++) {
        const existing = prev[i];
        const baseValues = existing ? { ...existing.values } : emptyValues();
        if (i < cleaned.length) {
          baseValues[key] = cleaned[i];
        }
        next.push({
          ...(existing || emptyRow()),
          id: existing ? existing.id : '',
          values: baseValues,
          image: existing ? existing.image : emptyImageState(),
          metafields: existing ? existing.metafields : {},
        });
      }
      // Validate the Status field's restricted values, normalizing valid values
      // to uppercase and clearing (blanking) unrecognized values.
      if (key === 'status') {
        const allowedStatus = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
        const badRows: number[] = [];
        const badValues: string[] = [];
        for (let i = 0; i < next.length; i++) {
          const val = next[i].values.status.trim();
          if (val === '') continue;
          const upper = val.toUpperCase();
          if (allowedStatus.includes(upper)) {
            next[i] = {
              ...next[i],
              values: { ...next[i].values, status: upper },
            };
          } else {
            badRows.push(i + 1);
            badValues.push(val);
            next[i] = {
              ...next[i],
              values: { ...next[i].values, status: '' },
            };
          }
        }
        setPasteValidationWarnings((prev) => {
          const updated = { ...prev };
          if (badRows.length > 0) {
            updated[key] =
              `Row(s) ${badRows.join(', ')} had unrecognized Status values (${badValues.join(', ')}) that were cleared. Allowed values are ACTIVE, DRAFT, ARCHIVED.`;
          } else {
            delete updated[key];
          }
          return updated;
        });
      }
      recordOverflow(key, fieldLabel, next, (r) => r.values[key]);
      return next;
    });
    setColumnPaste((prev) => ({ ...prev, [key]: '' }));
  }

  async function fetchProducts(gids: string[]): Promise<Record<string, FetchedProduct> | null> {
    const metafieldSelections = chosenDefinitions
      .map((d, i) => `mf${i}: metafield(namespace: "${d.namespace}", key: "${d.key}") { value }`)
      .join('\n');
    const query = `query GetProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          descriptionHtml
          vendor
          productType
          status
          tags
          media(first: 1) {
            nodes {
              ... on MediaImage {
                image { url }
              }
            }
          }
          variants(first: 1) {
            nodes {
              id
              inventoryItem {
                id
                measurement { weight { value unit } }
              }
            }
          }
          variantsCount { count }
          ${metafieldSelections}
        }
      }
    }`;

    const map: Record<string, FetchedProduct> = {};
    for (let i = 0; i < gids.length; i += BATCH_SIZE) {
      const batch = gids.slice(i, i + BATCH_SIZE);
      const { data, errors } = await shopify.query(query, {
        variables: { ids: batch },
      });
      if (errors && errors.length > 0) {
        setLookupError(errors.map((e: { message: string }) => e.message).join(', '));
        return null;
      }
      const nodes = (data?.nodes || []) as (Record<string, unknown> | null)[];
      for (const node of nodes) {
        if (node && typeof node.id === 'string') {
          const media = node.media as { nodes?: { image?: { url?: string } }[] } | undefined;
          const firstImage = media?.nodes?.[0]?.image?.url || '';
          const metafieldValues: Record<string, string> = {};
          chosenDefinitions.forEach((d, di) => {
            const mf = node[`mf${di}`] as { value?: string } | null | undefined;
            if (mf && typeof mf.value === 'string') {
              metafieldValues[`${d.namespace}.${d.key}`] = mf.value;
            }
          });
          const variants = node.variants as
            | {
                nodes?: {
                  id?: string;
                  inventoryItem?: {
                    id?: string;
                    measurement?: { weight?: { value?: number; unit?: string } };
                  };
                }[];
              }
            | undefined;
          const variantNodes = variants?.nodes || [];
          const firstVariant = variantNodes[0];
          const weight = firstVariant?.inventoryItem?.measurement?.weight;
          const variantsCount = node.variantsCount as { count?: number } | undefined;
          map[node.id] = {
            id: node.id,
            title: (node.title as string) || '',
            descriptionHtml: (node.descriptionHtml as string) || '',
            vendor: (node.vendor as string) || '',
            productType: (node.productType as string) || '',
            status: (node.status as string) || '',
            tags: (node.tags as string[]) || [],
            currentImageUrl: firstImage,
            metafieldValues,
            inventoryItemId: firstVariant?.inventoryItem?.id || '',
            variantCount:
              typeof variantsCount?.count === 'number' ? variantsCount.count : variantNodes.length,
            weightValue: typeof weight?.value === 'number' ? weight.value : null,
            weightUnit: weight?.unit || '',
          };
        }
      }
    }
    return map;
  }

  async function validateAndPreview() {
    setLookupError(null);
    setInvalidIds([]);
    setDuplicateIds([]);
    setCountWarnings([]);
    setParseWarnings([]);
    setValidating(true);

    try {
      const activeRows = rows.slice(0, MAX_ROWS).filter((r) => r.id.trim() !== '');

      const gidByRow: (string | null)[] = activeRows.map((r) => normalizeToGid(r.id));
      const badFormat: string[] = [];
      const uniqueGids: string[] = [];
      const seen: Record<string, number> = {};
      const dups: string[] = [];

      gidByRow.forEach((gid, idx) => {
        if (!gid) {
          badFormat.push(displayId(activeRows[idx].id));
          return;
        }
        if (seen[gid] === undefined) {
          seen[gid] = 1;
          uniqueGids.push(gid);
        } else {
          seen[gid] += 1;
          if (seen[gid] === 2) dups.push(displayId(gid));
        }
      });

      const fetched = uniqueGids.length > 0 ? await fetchProducts(uniqueGids) : {};
      if (fetched === null) {
        setValidating(false);
        return;
      }

      const missing: string[] = [];
      for (const gid of uniqueGids) {
        if (!fetched[gid]) missing.push(displayId(gid));
      }

      const allInvalid = [...badFormat, ...missing];
      setInvalidIds(allInvalid);
      setDuplicateIds(dups);
      setProductMap(fetched);

      const activeNonBlankIdCount = activeRows.length;
      const warnings: string[] = [];
      for (const f of chosenFields) {
        if (!pastedColumns[f.key]) continue;
        const valueCount = activeRows.filter((r) => r.values[f.key].trim() !== '').length;
        if (valueCount > 0 && valueCount !== activeNonBlankIdCount) {
          warnings.push(
            `The ${f.label} column has ${valueCount} values but there are ${activeNonBlankIdCount} product IDs. Row-by-row values may be misaligned.`,
          );
        }
      }
      setCountWarnings(warnings);

      if (allInvalid.length > 0) {
        setValidating(false);
        return;
      }

      // Determine which GIDs are duplicated and the index of the last (winning)
      // occurrence of each GID so preview rows can be labeled accordingly.
      const gidCounts: Record<string, number> = {};
      const lastIndexByGid: Record<string, number> = {};
      gidByRow.forEach((gid, idx) => {
        if (!gid) return;
        gidCounts[gid] = (gidCounts[gid] || 0) + 1;
        lastIndexByGid[gid] = idx;
      });

      const preview: PreviewRow[] = [];
      activeRows.forEach((r, idx) => {
        const gid = gidByRow[idx];
        if (!gid) return;
        const product = fetched[gid];
        if (!product) return;
        const isDuplicate = (gidCounts[gid] || 0) > 1;
        const duplicateRole: DuplicateRole = !isDuplicate
          ? 'none'
          : lastIndexByGid[gid] === idx
            ? 'winner'
            : 'overridden';
        for (const f of chosenFields) {
          const rawVal = r.values[f.key];
          if (rawVal.trim() === '') continue;

          let currentValue = '';
          let newValue = '';
          if (f.key === 'title') {
            currentValue = product.title;
            newValue = rawVal;
          } else if (f.key === 'description') {
            currentValue = stripHtml(product.descriptionHtml);
            newValue = rawVal;
          } else if (f.key === 'vendor') {
            currentValue = product.vendor;
            newValue = rawVal;
          } else if (f.key === 'productType') {
            currentValue = product.productType;
            newValue = rawVal;
          } else if (f.key === 'status') {
            currentValue = product.status;
            newValue = rawVal;
          } else if (f.key === 'tags') {
            currentValue = product.tags.join(', ');
            newValue = splitTags(rawVal).join(', ');
          }

          preview.push({
            key: `${gid}-${f.key}-${idx}`,
            productGid: gid,
            productTitle: product.title,
            field: f.key,
            fieldLabel: f.label,
            currentValue,
            newValue,
            newThumbnailUrl: null,
            imageSourceUrl: null,
            metafieldNamespace: null,
            metafieldKey: null,
            metafieldType: null,
            duplicateRole,
            inventoryItemId: null,
            currentInventoryQty: null,
            newInventoryQty: null,
            newWeightValue: null,
            variantCount: product.variantCount,
            checked: true,
          });
        }

        for (const d of chosenDefinitions) {
          const cell = r.metafields[d.id];
          if (!cell || !cell.touched || cell.value.trim() === '') continue;
          const currentMeta = product.metafieldValues[`${d.namespace}.${d.key}`];
          const newMetaValue = isListType(d.typeName) ? listCellToJson(cell.value) : cell.value;
          preview.push({
            key: `${gid}-mf-${d.id}-${idx}`,
            productGid: gid,
            productTitle: product.title,
            field: 'metafield',
            fieldLabel: d.name,
            currentValue: currentMeta === undefined || currentMeta === null ? 'none' : currentMeta,
            newValue: newMetaValue,
            newThumbnailUrl: null,
            imageSourceUrl: null,
            metafieldNamespace: d.namespace,
            metafieldKey: d.key,
            metafieldType: d.typeName,
            duplicateRole,
            inventoryItemId: null,
            currentInventoryQty: null,
            newInventoryQty: null,
            newWeightValue: null,
            variantCount: product.variantCount,
            checked: true,
          });
        }

        if (editInventory && r.inventoryQty.trim() !== '' && product.inventoryItemId) {
          const newQty = parseInt(r.inventoryQty.trim(), 10);
          if (!Number.isNaN(newQty)) {
            preview.push({
              key: `${gid}-inv-${idx}`,
              productGid: gid,
              productTitle: product.title,
              field: 'inventory',
              fieldLabel: INVENTORY_LABEL,
              currentValue: '',
              newValue: String(newQty),
              newThumbnailUrl: null,
              imageSourceUrl: null,
              metafieldNamespace: null,
              metafieldKey: null,
              metafieldType: null,
              duplicateRole,
              inventoryItemId: product.inventoryItemId,
              currentInventoryQty: null,
              newInventoryQty: newQty,
              newWeightValue: null,
              variantCount: product.variantCount,
              checked: true,
            });
          }
        }

        if (editWeight && r.weight.trim() !== '' && product.inventoryItemId) {
          const newW = parseFloat(r.weight.trim());
          if (!Number.isNaN(newW)) {
            preview.push({
              key: `${gid}-wt-${idx}`,
              productGid: gid,
              productTitle: product.title,
              field: 'weight',
              fieldLabel: WEIGHT_LABEL,
              currentValue: formatWeight(product.weightValue, product.weightUnit),
              newValue: `${newW} ${weightUnit}`,
              newThumbnailUrl: null,
              imageSourceUrl: null,
              metafieldNamespace: null,
              metafieldKey: null,
              metafieldType: null,
              duplicateRole,
              inventoryItemId: product.inventoryItemId,
              currentInventoryQty: null,
              newInventoryQty: null,
              newWeightValue: newW,
              variantCount: product.variantCount,
              checked: true,
            });
          }
        }

        if (editImage && r.image.selected) {
          preview.push({
            key: `${gid}-image-${idx}`,
            productGid: gid,
            productTitle: product.title,
            field: 'image',
            fieldLabel: IMAGE_LABEL,
            currentValue: product.currentImageUrl === '' ? 'none' : product.currentImageUrl,
            newValue: r.image.selected.sourceUrl,
            newThumbnailUrl: r.image.selected.thumbnailUrl,
            imageSourceUrl: r.image.selected.sourceUrl,
            metafieldNamespace: null,
            metafieldKey: null,
            metafieldType: null,
            duplicateRole,
            inventoryItemId: null,
            currentInventoryQty: null,
            newInventoryQty: null,
            newWeightValue: null,
            variantCount: product.variantCount,
            checked: true,
          });
        }
      });

      // Collect warnings for inventory/weight cells that could not be parsed and
      // were therefore excluded from the preview.
      const parseIssues: string[] = [];
      activeRows.forEach((r, idx) => {
        const rowNum = idx + 1;
        if (editInventory && r.inventoryQty.trim() !== '') {
          const parsed = parseInt(r.inventoryQty.trim(), 10);
          if (Number.isNaN(parsed)) {
            parseIssues.push(
              `Row ${rowNum}: Inventory quantity value "${r.inventoryQty.trim()}" is not a valid integer and was not included in the preview.`,
            );
          }
        }
        if (editWeight && r.weight.trim() !== '') {
          const parsed = parseFloat(r.weight.trim());
          if (Number.isNaN(parsed)) {
            parseIssues.push(
              `Row ${rowNum}: Weight value "${r.weight.trim()}" is not a valid number and was not included in the preview.`,
            );
          }
        }
      });
      setParseWarnings(parseIssues);

      // Fetch current available inventory quantity for each inventory preview row.
      if (editInventory && selectedLocationId) {
        const invRows = preview.filter((p) => p.field === 'inventory' && p.inventoryItemId);
        const levelQuery = `query GetInventoryLevel($locationId: ID!, $inventoryItemId: ID!) {
          location(id: $locationId) {
            inventoryLevel(inventoryItemId: $inventoryItemId) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }`;
        for (const p of invRows) {
          try {
            const { data } = await shopify.query(levelQuery, {
              variables: { locationId: selectedLocationId, inventoryItemId: p.inventoryItemId },
            });
            const quantities = (data?.location?.inventoryLevel?.quantities || []) as {
              name?: string;
              quantity?: number;
            }[];
            const avail = quantities.find((q) => q.name === 'available');
            p.currentInventoryQty = typeof avail?.quantity === 'number' ? avail.quantity : null;
            p.currentValue =
              p.currentInventoryQty === null ? 'none' : String(p.currentInventoryQty);
          } catch {
            p.currentInventoryQty = null;
            p.currentValue = 'none';
          }
        }
      }

      setPreviewRows(preview);
      setStep('preview');
    } finally {
      setValidating(false);
    }
  }

  const canContinue =
    (anyFieldSelected || editImage || editInventory || editWeight) &&
    (!editInventory || selectedLocationId !== '');
  const canPreview =
    nonBlankIdCount > 0 && anyFieldValueEntered && invalidIds.length === 0 && !validating;

  function togglePreviewRow(key: string, checked: boolean) {
    setPreviewRows((prev) => prev.map((r) => (r.key === key ? { ...r, checked } : r)));
  }

  function toggleAllPreview(checked: boolean) {
    setPreviewRows((prev) => prev.map((r) => ({ ...r, checked })));
  }

  const checkedPreviewCount = previewRows.filter((r) => r.checked).length;
  const allPreviewChecked = previewRows.length > 0 && checkedPreviewCount === previewRows.length;
  const somePreviewChecked = checkedPreviewCount > 0 && checkedPreviewCount < previewRows.length;

  async function applyChanges() {
    setApplying(true);
    setResults([]);

    const updateMutation = `mutation UpdateProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product {
          id
          media(first: 10, reverse: true) {
            nodes {
              id
              ... on MediaImage { image { url } }
            }
          }
        }
        userErrors { field message }
      }
    }`;

    const reorderMutation = `mutation ReorderProductMedia($productId: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $productId, moves: $moves) {
        mediaUserErrors { field message }
      }
    }`;

    const firstMediaQuery = `query FirstMedia($productId: ID!) {
      product(id: $productId) {
        media(first: 1) {
          nodes { id }
        }
      }
    }`;

    // Poll the product's media list up to 5 times (1s apart) to confirm the new
    // image reached the first position. Returns true only when confirmed.
    const confirmFeatured = async (productId: string, newMediaId: string): Promise<boolean> => {
      for (let poll = 0; poll < 5; poll++) {
        await delay(1000);
        try {
          const { data, errors } = await shopify.query(firstMediaQuery, {
            variables: { productId },
          });
          if (errors && errors.length > 0) continue;
          const firstId = data?.product?.media?.nodes?.[0]?.id;
          if (firstId === newMediaId) return true;
        } catch {
          // Ignore poll errors and try again until attempts are exhausted.
        }
      }
      return false;
    };

    interface MetafieldInput {
      namespace: string;
      key: string;
      value: string;
      type: string;
    }

    const inventoryMutation = `mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message code }
      }
    }`;

    const weightMutation = `mutation UpdateWeight($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        userErrors { field message }
      }
    }`;

    interface GroupEntry {
      title: string;
      input: Record<string, unknown>;
      imageSourceUrl: string | null;
      metafields: Record<string, MetafieldInput>;
      hasFieldChange: boolean;
      inventoryItemId: string | null;
      newInventoryQty: number | null;
      currentInventoryQty: number | null;
      newWeightValue: number | null;
    }

    const grouped: Record<string, GroupEntry> = {};

    for (const r of previewRows) {
      if (!r.checked) continue;
      if (!grouped[r.productGid]) {
        grouped[r.productGid] = {
          title: r.productTitle,
          input: { id: r.productGid },
          imageSourceUrl: null,
          metafields: {},
          hasFieldChange: false,
          inventoryItemId: null,
          newInventoryQty: null,
          currentInventoryQty: null,
          newWeightValue: null,
        };
      }
      const entry = grouped[r.productGid];
      if (r.field === 'image') {
        entry.imageSourceUrl = r.imageSourceUrl;
        continue;
      }
      if (r.field === 'inventory') {
        entry.inventoryItemId = r.inventoryItemId;
        entry.newInventoryQty = r.newInventoryQty;
        entry.currentInventoryQty = r.currentInventoryQty;
        continue;
      }
      if (r.field === 'weight') {
        entry.inventoryItemId = r.inventoryItemId;
        entry.newWeightValue = r.newWeightValue;
        continue;
      }
      if (r.field === 'metafield') {
        entry.hasFieldChange = true;
        if (r.metafieldNamespace && r.metafieldKey && r.metafieldType) {
          // Keyed by namespace.key so a later duplicate-ID row overwrites an
          // earlier one for the same metafield (last row wins).
          entry.metafields[`${r.metafieldNamespace}.${r.metafieldKey}`] = {
            namespace: r.metafieldNamespace,
            key: r.metafieldKey,
            value: r.newValue,
            type: r.metafieldType,
          };
        }
        continue;
      }
      entry.hasFieldChange = true;
      const input = entry.input;
      if (r.field === 'title') input.title = r.newValue;
      else if (r.field === 'description') input.descriptionHtml = r.newValue;
      else if (r.field === 'vendor') input.vendor = r.newValue;
      else if (r.field === 'productType') input.productType = r.newValue;
      else if (r.field === 'status') input.status = r.newValue;
      else if (r.field === 'tags') input.tags = splitTags(r.newValue);
    }

    for (const entry of Object.values(grouped)) {
      const metafieldList = Object.values(entry.metafields);
      if (metafieldList.length > 0) {
        entry.input.metafields = metafieldList;
      }
    }

    const entries = Object.values(grouped);
    setApplyProgress({ done: 0, total: entries.length });

    const MAX_RETRIES = 3;
    const BACKOFF_MS = [1000, 2000, 4000];

    // Runs a mutation with the shared throttle retry/backoff. Returns the parsed
    // result and whether it was throttled after all retries were exhausted.
    const runWithRetry = async (
      variables: Record<string, unknown>,
      mutationStr: string,
    ): Promise<{
      data: Record<string, unknown> | null;
      error: string | null;
      throttled: boolean;
    }> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const { data, errors } = await shopify.query(mutationStr, { variables });
          if (errors && errors.length > 0) {
            if (isThrottleError(null, errors)) {
              if (attempt < MAX_RETRIES) {
                await delay(BACKOFF_MS[attempt]);
                continue;
              }
              return { data: null, error: null, throttled: true };
            }
            return {
              data: null,
              error: errors.map((e: { message: string }) => e.message).join(', '),
              throttled: false,
            };
          }
          return { data: data as Record<string, unknown>, error: null, throttled: false };
        } catch (err) {
          if (isThrottleError(err)) {
            if (attempt < MAX_RETRIES) {
              await delay(BACKOFF_MS[attempt]);
              continue;
            }
            return { data: null, error: null, throttled: true };
          }
          return {
            data: null,
            error: err instanceof Error ? err.message : 'Request failed',
            throttled: false,
          };
        }
      }
      return { data: null, error: null, throttled: true };
    };

    const formatUserErrors = (userErrors: { field?: string[]; message: string }[]): string =>
      userErrors
        .map((e) =>
          e.field && e.field.length > 0 ? `${e.field.join('.')}: ${e.message}` : e.message,
        )
        .join(', ');

    const collected: ResultRow[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const media = entry.imageSourceUrl
        ? [{ mediaContentType: 'IMAGE', originalSource: entry.imageSourceUrl }]
        : null;

      let messages: string[] = [];
      let partialMessage = '';
      let productUpdateFailed = false;
      let anySucceeded = false;

      const needsProductUpdate = entry.hasFieldChange || entry.imageSourceUrl !== null;

      // Each product's update is isolated: rate-limit failures are retried with
      // exponential backoff, and any other failure is recorded so the batch continues.
      if (needsProductUpdate)
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          messages = [];
          partialMessage = '';
          productUpdateFailed = false;
          let throttled = false;

          try {
            const { data, errors } = await shopify.query(updateMutation, {
              variables: { product: entry.input, media },
            });
            if (errors && errors.length > 0) {
              if (isThrottleError(null, errors)) {
                throttled = true;
              } else {
                messages.push(errors.map((e: { message: string }) => e.message).join(', '));
              }
            } else {
              const userErrors = data?.productUpdate?.userErrors || [];
              if (userErrors.length > 0) {
                productUpdateFailed = true;
                messages.push(formatUserErrors(userErrors));
              } else if (entry.imageSourceUrl) {
                // The image was added; find the newly created media node and move it
                // to the first position so it becomes the featured image.
                const mediaNodes = (data?.productUpdate?.product?.media?.nodes || []) as {
                  id?: string;
                  image?: { url?: string };
                }[];
                const added = mediaNodes.find((n) => n.image?.url === entry.imageSourceUrl);
                const newMediaId = added?.id || mediaNodes[0]?.id;
                if (newMediaId) {
                  const { data: reorderData, errors: reorderErrors } = await shopify.query(
                    reorderMutation,
                    {
                      variables: {
                        productId: entry.input.id,
                        moves: [{ id: newMediaId, newPosition: '0' }],
                      },
                    },
                  );
                  if (reorderErrors && reorderErrors.length > 0) {
                    if (isThrottleError(null, reorderErrors)) {
                      throttled = true;
                    } else {
                      messages.push(
                        'Image added but could not be set as featured: ' +
                          reorderErrors.map((e: { message: string }) => e.message).join(', '),
                      );
                    }
                  } else {
                    const mediaUserErrors = reorderData?.productReorderMedia?.mediaUserErrors || [];
                    if (mediaUserErrors.length > 0) {
                      messages.push(
                        'Image added but could not be set as featured: ' +
                          mediaUserErrors
                            .map((e: { field?: string[]; message: string }) =>
                              e.field && e.field.length > 0
                                ? `${e.field.join('.')}: ${e.message}`
                                : e.message,
                            )
                            .join(', '),
                      );
                    } else {
                      // Reorder accepted; poll to confirm the image reached position 0.
                      const confirmed = await confirmFeatured(entry.input.id as string, newMediaId);
                      if (!confirmed) {
                        partialMessage =
                          'Image added, but could not confirm it was set as featured image. Please verify in the product editor.';
                      }
                    }
                  }
                } else {
                  messages.push(
                    'Image added but its media ID could not be found to set as featured.',
                  );
                }
              }
            }
          } catch (err) {
            if (isThrottleError(err)) {
              throttled = true;
            } else {
              messages.push(err instanceof Error ? err.message : 'Update failed');
            }
          }

          if (throttled && attempt < MAX_RETRIES) {
            await delay(BACKOFF_MS[attempt]);
            continue;
          }

          if (throttled) {
            productUpdateFailed = true;
            messages.push(
              'Rate limited by Shopify after 3 retries. Please try this product again.',
            );
          }
          break;
        }

      if (needsProductUpdate && !productUpdateFailed) {
        anySucceeded = true;
      }

      // Only proceed to inventory/weight if the productUpdate step (if any) did not fail.
      if (!productUpdateFailed) {
        if (entry.inventoryItemId && entry.newInventoryQty !== null) {
          const result = await runWithRetry(
            {
              input: {
                name: 'available',
                reason: 'correction',
                quantities: [
                  {
                    inventoryItemId: entry.inventoryItemId,
                    locationId: selectedLocationId,
                    quantity: entry.newInventoryQty,
                    changeFromQuantity: entry.currentInventoryQty ?? 0,
                  },
                ],
              },
            },
            inventoryMutation,
          );
          if (result.throttled) {
            partialMessage = partialMessage
              ? partialMessage +
                ' Inventory was rate limited after 3 retries; please re-check and resubmit.'
              : 'Inventory was rate limited after 3 retries; please re-check and resubmit.';
          } else if (result.error) {
            partialMessage = partialMessage ? partialMessage + ' ' + result.error : result.error;
          } else {
            const invUserErrors = ((
              result.data?.inventorySetQuantities as {
                userErrors?: { field?: string[]; message: string; code?: string }[];
              }
            )?.userErrors || []) as { field?: string[]; message: string; code?: string }[];
            if (invUserErrors.length > 0) {
              const invMsg = invUserErrors
                .map((e) => {
                  const code = (e.code || '').toUpperCase();
                  if (code.includes('STALE') || code.includes('CONFLICT')) {
                    return 'Inventory changed since preview — please re-check and resubmit.';
                  }
                  return e.field && e.field.length > 0
                    ? `${e.field.join('.')}: ${e.message}`
                    : e.message;
                })
                .join(', ');
              partialMessage = partialMessage ? partialMessage + ' ' + invMsg : invMsg;
            } else {
              anySucceeded = true;
            }
          }
        }

        if (entry.inventoryItemId && entry.newWeightValue !== null) {
          const result = await runWithRetry(
            {
              id: entry.inventoryItemId,
              input: { measurement: { weight: { value: entry.newWeightValue, unit: weightUnit } } },
            },
            weightMutation,
          );
          if (result.throttled) {
            partialMessage = partialMessage
              ? partialMessage +
                ' Weight was rate limited after 3 retries; please re-check and resubmit.'
              : 'Weight was rate limited after 3 retries; please re-check and resubmit.';
          } else if (result.error) {
            const wMsg = 'Weight update failed: ' + result.error;
            partialMessage = partialMessage ? partialMessage + ' ' + wMsg : wMsg;
          } else {
            const wUserErrors = ((
              result.data?.inventoryItemUpdate as {
                userErrors?: { field?: string[]; message: string }[];
              }
            )?.userErrors || []) as { field?: string[]; message: string }[];
            if (wUserErrors.length > 0) {
              const wMsg = 'Weight update failed: ' + formatUserErrors(wUserErrors);
              partialMessage = partialMessage ? partialMessage + ' ' + wMsg : wMsg;
            } else {
              anySucceeded = true;
            }
          }
        }
      }

      let status: ResultStatus;
      let errorText: string;
      if (messages.length > 0) {
        status = 'failed';
        errorText = messages.join(', ');
      } else if (partialMessage !== '' && anySucceeded) {
        status = 'partial';
        errorText = partialMessage;
      } else if (partialMessage !== '' && !anySucceeded) {
        status = 'failed';
        errorText = partialMessage;
      } else {
        status = 'success';
        errorText = '';
      }
      collected.push({
        productTitle: entry.title,
        status,
        error: errorText,
      });
      setApplyProgress({ done: i + 1, total: entries.length });
    }

    setResults(collected);
    setApplying(false);
    setStep('results');
  }

  function startOver() {
    setStep('select');
    setSelectedFields({
      title: false,
      description: false,
      vendor: false,
      productType: false,
      status: false,
      tags: false,
    });
    setRows([emptyRow()]);
    setEditImage(false);
    setEditInventory(false);
    setEditWeight(false);
    setInventoryPaste('');
    setWeightPaste('');
    setFillValues({});
    setSelectedDefinitions({});
    setPastedMetafields({});
    setMetafieldPaste({});
    setIdPaste('');
    setColumnPaste(emptyValues());
    setPastedColumns({
      title: false,
      description: false,
      vendor: false,
      productType: false,
      status: false,
      tags: false,
    });
    setLookupError(null);
    setInvalidIds([]);
    setDuplicateIds([]);
    setCountWarnings([]);
    setParseWarnings([]);
    setPasteOverflowWarnings({});
    setPasteValidationWarnings({});
    setProductMap({});
    setPreviewRows([]);
    setResults([]);
    setApplyProgress({ done: 0, total: 0 });
  }

  void productMap;

  if (step === 'select') {
    return (
      <s-page heading="Bulk product editor">
        <s-section heading="Choose fields to edit">
          <s-paragraph>
            Select which product fields you want to bulk edit. The grid on the next step will have
            one column for each field you choose.
          </s-paragraph>
          <s-stack gap="base">
            <s-stack gap="small">
              <s-heading>Standard fields</s-heading>
              {FIELD_DEFS.map((f) => (
                <s-checkbox
                  key={f.key}
                  label={f.label}
                  checked={selectedFields[f.key]}
                  onChange={(e: Event) =>
                    toggleField(f.key, (e.currentTarget as HTMLInputElement).checked)
                  }
                />
              ))}
            </s-stack>
            <s-divider />
            <s-stack gap="small">
              <s-heading>Media</s-heading>
              <s-checkbox
                label={IMAGE_LABEL}
                checked={editImage}
                onChange={(e: Event) => setEditImage((e.currentTarget as HTMLInputElement).checked)}
              />
            </s-stack>
            <s-divider />
            <s-stack gap="small">
              <s-heading>Inventory & weight</s-heading>
              <s-checkbox
                label={INVENTORY_LABEL}
                checked={editInventory}
                onChange={(e: Event) =>
                  setEditInventory((e.currentTarget as HTMLInputElement).checked)
                }
              />
              <s-checkbox
                label={WEIGHT_LABEL}
                checked={editWeight}
                onChange={(e: Event) =>
                  setEditWeight((e.currentTarget as HTMLInputElement).checked)
                }
              />
              {editInventory && (
                <s-stack gap="small">
                  <LoadingSection
                    loading={locationsLoading}
                    error={locationsError}
                    onRetry={() => setLocationsLoaded(false)}
                    loadingLabel="Loading locations..."
                    errorHeading="Could not load locations"
                  >
                    {locations.length === 0 ? (
                      <s-text color="subdued">No active locations found.</s-text>
                    ) : (
                      <s-select
                        label="Location (for inventory)"
                        value={selectedLocationId}
                        onChange={(e: Event) =>
                          setSelectedLocationId((e.currentTarget as HTMLSelectElement).value)
                        }
                      >
                        {locations.map((l) => (
                          <s-option key={l.id} value={l.id}>
                            {l.name}
                          </s-option>
                        ))}
                      </s-select>
                    )}
                  </LoadingSection>
                </s-stack>
              )}
              {editWeight && (
                <s-select
                  label="Weight unit"
                  value={weightUnit}
                  onChange={(e: Event) =>
                    setWeightUnit((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  {WEIGHT_UNITS.map((u) => (
                    <s-option key={u.value} value={u.value}>
                      {u.label}
                    </s-option>
                  ))}
                </s-select>
              )}
            </s-stack>
          </s-stack>
        </s-section>
        <s-section heading="Product metafields">
          <LoadingSection
            loading={definitionsLoading}
            error={definitionsError}
            onRetry={() => setDefinitionsLoaded(false)}
            loadingLabel="Loading metafield definitions..."
            errorHeading="Could not load metafield definitions"
          >
            {definitions.length === 0 ? (
              <s-text color="subdued">No product metafield definitions found in this store.</s-text>
            ) : (
              <s-stack gap="small">
                {definitions.map((d) => (
                  <s-checkbox
                    key={d.id}
                    label={d.name}
                    details={`${d.namespace}.${d.key}`}
                    checked={!!selectedDefinitions[d.id]}
                    onChange={(e: Event) =>
                      toggleDefinition(d.id, (e.currentTarget as HTMLInputElement).checked)
                    }
                  />
                ))}
              </s-stack>
            )}
          </LoadingSection>
        </s-section>
        <s-stack direction="inline" gap="base" justifyContent="end">
          <s-button variant="primary" disabled={!canContinue} onClick={() => setStep('grid')}>
            Continue
          </s-button>
        </s-stack>
      </s-page>
    );
  }

  if (step === 'grid') {
    return (
      <s-page heading="Bulk product editor">
        {lookupError && (
          <s-banner tone="critical" heading="Could not look up products">
            <s-paragraph>{lookupError}</s-paragraph>
          </s-banner>
        )}
        {invalidIds.length > 0 && (
          <s-banner tone="critical" heading="Some product IDs are not valid">
            <s-stack gap="small-300">
              {invalidIds.map((id) => (
                <s-text key={id}>Product ID {id} does not match a real product.</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {duplicateIds.length > 0 && (
          <s-banner tone="warning" heading="Duplicate product IDs">
            <s-stack gap="small-300">
              {duplicateIds.map((id) => (
                <s-text key={id}>
                  Product ID {id} appears more than once; only the last row's values for it will be
                  applied.
                </s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {countWarnings.length > 0 && (
          <s-banner tone="warning" heading="Value counts do not match">
            <s-stack gap="small-300">
              {countWarnings.map((w, i) => (
                <s-text key={i}>{w}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {parseWarnings.length > 0 && (
          <s-banner tone="warning" heading="Some values could not be read">
            <s-stack gap="small-300">
              {parseWarnings.map((w, i) => (
                <s-text key={i}>{w}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {Object.keys(pasteOverflowWarnings).length > 0 && (
          <s-banner tone="warning" heading="Some pasted values had no matching product">
            <s-stack gap="small-300">
              {Object.entries(pasteOverflowWarnings).map(([k, w]) => (
                <s-text key={k}>{w}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {Object.keys(pasteValidationWarnings).length > 0 && (
          <s-banner tone="warning" heading="Some pasted values are not allowed">
            <s-stack gap="small-300">
              {Object.entries(pasteValidationWarnings).map(([k, w]) => (
                <s-text key={k}>{w}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        {excessRows && (
          <s-banner tone="warning" heading="Too many products">
            <s-paragraph>
              Only the first {MAX_ROWS} products can be edited at once. Rows beyond {MAX_ROWS} are
              excluded.
            </s-paragraph>
          </s-banner>
        )}
        {nonBlankIdCount === 0 && (
          <s-banner tone="info" heading="Add product IDs">
            <s-paragraph>Enter at least one product ID to continue.</s-paragraph>
          </s-banner>
        )}
        {nonBlankIdCount > 0 && !anyFieldValueEntered && (
          <s-banner tone="info" heading="No changes entered">
            <s-paragraph>No field values entered, so there is nothing to change.</s-paragraph>
          </s-banner>
        )}

        <s-section heading="Paste columns">
          <s-paragraph>
            Paste values into a column and click Apply. For single-line fields (Title, Vendor,
            Product type, Status, Tags), paste one value per line. For multi-line fields
            (Description and applicable metafields), separate each product's value with a line
            containing only ---. See each field's placeholder for details.
          </s-paragraph>
          <s-stack gap="base">
            <s-stack gap="small">
              <s-text-area
                label="Product IDs"
                rows={4}
                placeholder="Paste product IDs, one per line"
                value={idPaste}
                onInput={(e: Event) => setIdPaste((e.currentTarget as HTMLTextAreaElement).value)}
              />
              <s-stack direction="inline" gap="small" justifyContent="start">
                <s-button onClick={applyIdPaste} disabled={idPaste.trim() === ''}>
                  Apply to ID column
                </s-button>
                <s-button onClick={browseProducts}>Browse products</s-button>
              </s-stack>
            </s-stack>
            {chosenFields.map((f) => (
              <s-stack gap="small" key={f.key}>
                <s-divider />
                <s-text-area
                  label={f.label}
                  rows={4}
                  placeholder={
                    f.input === 'textarea'
                      ? "Paste one description per product. Put a line containing only --- between each product's value. Blank lines within a value are kept as-is."
                      : `Paste ${f.label.toLowerCase()} values, one per line`
                  }
                  value={columnPaste[f.key]}
                  onInput={(e: Event) =>
                    setColumnPaste((prev) => ({
                      ...prev,
                      [f.key]: (e.currentTarget as HTMLTextAreaElement).value,
                    }))
                  }
                />
                <s-stack direction="inline" justifyContent="start">
                  <s-button
                    onClick={() => applyColumnPaste(f.key)}
                    disabled={columnPaste[f.key].trim() === ''}
                  >
                    Apply to {f.label} column
                  </s-button>
                </s-stack>
              </s-stack>
            ))}
            {chosenDefinitions.map((d) => (
              <s-stack gap="small" key={d.id}>
                <s-divider />
                <s-text-area
                  label={d.name}
                  rows={4}
                  placeholder={
                    metafieldInputKind(d) === 'list'
                      ? "Paste one value per product. Put a line containing only --- between each product's value. Within each product's block, each line is one list item. Blank lines within a block are ignored."
                      : ['textarea', 'json'].includes(metafieldInputKind(d))
                        ? "Paste one value per product. Put a line containing only --- between each product's value. Blank lines within a value are kept as-is."
                        : `Paste ${d.name.toLowerCase()} values, one per line`
                  }
                  value={metafieldPaste[d.id] || ''}
                  onInput={(e: Event) =>
                    setMetafieldPaste((prev) => ({
                      ...prev,
                      [d.id]: (e.currentTarget as HTMLTextAreaElement).value,
                    }))
                  }
                />
                <s-stack direction="inline" justifyContent="start">
                  <s-button
                    onClick={() => applyMetafieldPaste(d.id)}
                    disabled={(metafieldPaste[d.id] || '').trim() === ''}
                  >
                    Apply to {d.name} column
                  </s-button>
                </s-stack>
              </s-stack>
            ))}
            {editInventory && (
              <s-stack gap="small">
                <s-divider />
                <s-text-area
                  label={INVENTORY_LABEL}
                  rows={4}
                  placeholder="Paste inventory quantities, one per line"
                  value={inventoryPaste}
                  onInput={(e: Event) =>
                    setInventoryPaste((e.currentTarget as HTMLTextAreaElement).value)
                  }
                />
                <s-stack direction="inline" justifyContent="start">
                  <s-button onClick={applyInventoryPaste} disabled={inventoryPaste.trim() === ''}>
                    Apply to {INVENTORY_LABEL} column
                  </s-button>
                </s-stack>
              </s-stack>
            )}
            {editWeight && (
              <s-stack gap="small">
                <s-divider />
                <s-text-area
                  label={WEIGHT_LABEL}
                  rows={4}
                  placeholder="Paste weights, one per line"
                  value={weightPaste}
                  onInput={(e: Event) =>
                    setWeightPaste((e.currentTarget as HTMLTextAreaElement).value)
                  }
                />
                <s-stack direction="inline" justifyContent="start">
                  <s-button onClick={applyWeightPaste} disabled={weightPaste.trim() === ''}>
                    Apply to {WEIGHT_LABEL} column
                  </s-button>
                </s-stack>
              </s-stack>
            )}
          </s-stack>
        </s-section>

        <s-section
          heading="Edit grid"
          padding="none"
          accessibilityLabel="Edit grid — product field values"
        >
          <s-box padding="base">
            <s-paragraph>
              Blank field cells are left unchanged. Tags replace the product's existing tags and are
              separated by commas. Selecting an image sets it as the product's featured image. List
              metafields take one value per line.
            </s-paragraph>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header>Product ID</s-table-header>
              {chosenFields.map((f) => (
                <s-table-header key={f.key}>
                  <s-stack gap="small">
                    <s-text>{f.label}</s-text>
                    <s-stack direction="inline" gap="small-300" alignItems="end">
                      {f.input === 'status' ? (
                        <s-select
                          label={`Fill all ${f.label}`}
                          labelAccessibilityVisibility="exclusive"
                          value={fillValues[f.key] || ''}
                          onChange={(e: Event) =>
                            setFillValue(f.key, (e.currentTarget as HTMLSelectElement).value)
                          }
                        >
                          <s-option value="">No change</s-option>
                          <s-option value="ACTIVE">Active</s-option>
                          <s-option value="DRAFT">Draft</s-option>
                          <s-option value="ARCHIVED">Archived</s-option>
                        </s-select>
                      ) : f.input === 'textarea' ? (
                        <s-text-area
                          label={`Fill all ${f.label}`}
                          labelAccessibilityVisibility="exclusive"
                          rows={2}
                          placeholder="Value for all"
                          value={fillValues[f.key] || ''}
                          onInput={(e: Event) =>
                            setFillValue(f.key, (e.currentTarget as HTMLTextAreaElement).value)
                          }
                        />
                      ) : (
                        <s-text-field
                          label={`Fill all ${f.label}`}
                          labelAccessibilityVisibility="exclusive"
                          placeholder="Value for all"
                          value={fillValues[f.key] || ''}
                          onInput={(e: Event) =>
                            setFillValue(f.key, (e.currentTarget as HTMLInputElement).value)
                          }
                        />
                      )}
                      <s-button
                        variant="tertiary"
                        onClick={() => fillColumn(f.key, fillValues[f.key] || '', 'standard')}
                      >
                        Fill all
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-table-header>
              ))}
              {chosenDefinitions.map((d) => {
                const kind = metafieldInputKind(d);
                return (
                  <s-table-header key={d.id}>
                    <s-stack gap="small">
                      <s-text>{d.name}</s-text>
                      <s-stack direction="inline" gap="small-300" alignItems="end">
                        {kind === 'select' ? (
                          <s-select
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            value={fillValues[d.id] || ''}
                            onChange={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLSelectElement).value)
                            }
                          >
                            <s-option value="">No change</s-option>
                            {(d.choices || []).map((c) => (
                              <s-option key={c} value={c}>
                                {c}
                              </s-option>
                            ))}
                          </s-select>
                        ) : kind === 'boolean' ? (
                          <s-select
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            value={fillValues[d.id] || ''}
                            onChange={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLSelectElement).value)
                            }
                          >
                            <s-option value="">No change</s-option>
                            <s-option value="true">True</s-option>
                            <s-option value="false">False</s-option>
                          </s-select>
                        ) : kind === 'list' ? (
                          <s-text-area
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            rows={2}
                            placeholder="One value per line"
                            value={fillValues[d.id] || ''}
                            onInput={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLTextAreaElement).value)
                            }
                          />
                        ) : kind === 'textarea' ? (
                          <s-text-area
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            rows={2}
                            placeholder="Value for all"
                            value={fillValues[d.id] || ''}
                            onInput={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLTextAreaElement).value)
                            }
                          />
                        ) : kind === 'integer' || kind === 'decimal' ? (
                          <s-number-field
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            inputMode={kind === 'decimal' ? 'decimal' : 'numeric'}
                            step={kind === 'decimal' ? 0.01 : 1}
                            value={fillValues[d.id] || ''}
                            onInput={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLInputElement).value)
                            }
                          />
                        ) : (
                          <s-text-field
                            label={`Fill all ${d.name}`}
                            labelAccessibilityVisibility="exclusive"
                            placeholder="Value for all"
                            value={fillValues[d.id] || ''}
                            onInput={(e: Event) =>
                              setFillValue(d.id, (e.currentTarget as HTMLInputElement).value)
                            }
                          />
                        )}
                        <s-button
                          variant="tertiary"
                          onClick={() => fillColumn(d.id, fillValues[d.id] || '', 'metafield')}
                        >
                          Fill all
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-table-header>
                );
              })}
              {editInventory && (
                <s-table-header format="numeric">
                  <s-stack gap="small">
                    <s-text>{INVENTORY_LABEL}</s-text>
                    <s-stack direction="inline" gap="small-300" alignItems="end">
                      <s-number-field
                        label={`Fill all ${INVENTORY_LABEL}`}
                        labelAccessibilityVisibility="exclusive"
                        inputMode="numeric"
                        step={1}
                        value={fillValues['__inventory'] || ''}
                        onInput={(e: Event) =>
                          setFillValue('__inventory', (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          fillColumn('__inventory', fillValues['__inventory'] || '', 'inventory')
                        }
                      >
                        Fill all
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-table-header>
              )}
              {editWeight && (
                <s-table-header format="numeric">
                  <s-stack gap="small">
                    <s-text>{WEIGHT_LABEL}</s-text>
                    <s-stack direction="inline" gap="small-300" alignItems="end">
                      <s-number-field
                        label={`Fill all ${WEIGHT_LABEL}`}
                        labelAccessibilityVisibility="exclusive"
                        inputMode="decimal"
                        step={0.01}
                        value={fillValues['__weight'] || ''}
                        onInput={(e: Event) =>
                          setFillValue('__weight', (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          fillColumn('__weight', fillValues['__weight'] || '', 'weight')
                        }
                      >
                        Fill all
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-table-header>
              )}
              {editImage && <s-table-header>{IMAGE_LABEL}</s-table-header>}
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row, index) => {
                const beyondLimit = index >= MAX_ROWS;
                return (
                  <s-table-row key={index}>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-text-field
                          label="Product ID"
                          labelAccessibilityVisibility="exclusive"
                          value={row.id}
                          error={beyondLimit ? 'Excluded (over limit)' : undefined}
                          onInput={(e: Event) =>
                            updateRowId(index, (e.currentTarget as HTMLInputElement).value)
                          }
                        />
                        {row.title !== '' && <s-text color="subdued">{row.title}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    {chosenFields.map((f) => (
                      <s-table-cell key={f.key}>
                        {f.input === 'status' ? (
                          <s-select
                            label={f.label}
                            labelAccessibilityVisibility="exclusive"
                            value={row.values.status}
                            onChange={(e: Event) =>
                              updateRowValue(
                                index,
                                'status',
                                (e.currentTarget as HTMLSelectElement).value,
                              )
                            }
                          >
                            <s-option value="">No change</s-option>
                            <s-option value="ACTIVE">Active</s-option>
                            <s-option value="DRAFT">Draft</s-option>
                            <s-option value="ARCHIVED">Archived</s-option>
                          </s-select>
                        ) : f.input === 'textarea' ? (
                          <s-text-area
                            label={f.label}
                            labelAccessibilityVisibility="exclusive"
                            rows={2}
                            value={row.values[f.key]}
                            onInput={(e: Event) =>
                              updateRowValue(
                                index,
                                f.key,
                                (e.currentTarget as HTMLTextAreaElement).value,
                              )
                            }
                          />
                        ) : (
                          <s-text-field
                            label={f.label}
                            labelAccessibilityVisibility="exclusive"
                            value={row.values[f.key]}
                            onInput={(e: Event) =>
                              updateRowValue(
                                index,
                                f.key,
                                (e.currentTarget as HTMLInputElement).value,
                              )
                            }
                          />
                        )}
                      </s-table-cell>
                    ))}
                    {chosenDefinitions.map((d) => {
                      const cell = row.metafields[d.id] || emptyMetafieldCell();
                      const kind = metafieldInputKind(d);
                      return (
                        <s-table-cell key={d.id}>
                          {kind === 'select' ? (
                            <s-select
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              value={cell.value}
                              onChange={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLSelectElement).value,
                                )
                              }
                            >
                              <s-option value="">No change</s-option>
                              {(d.choices || []).map((c) => (
                                <s-option key={c} value={c}>
                                  {c}
                                </s-option>
                              ))}
                            </s-select>
                          ) : kind === 'boolean' ? (
                            <s-select
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              value={cell.value}
                              onChange={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLSelectElement).value,
                                )
                              }
                            >
                              <s-option value="">No change</s-option>
                              <s-option value="true">True</s-option>
                              <s-option value="false">False</s-option>
                            </s-select>
                          ) : kind === 'list' ? (
                            <s-text-area
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              rows={3}
                              placeholder="One value per line"
                              details={
                                isChoiceRestrictedList(d)
                                  ? `Each line must be one of: ${(d.choices || []).join(', ')}`
                                  : 'Enter one value per line. Each line becomes one item in the list.'
                              }
                              value={cell.value}
                              onInput={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLTextAreaElement).value,
                                )
                              }
                            />
                          ) : kind === 'textarea' ? (
                            <s-text-area
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              rows={2}
                              value={cell.value}
                              onInput={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLTextAreaElement).value,
                                )
                              }
                            />
                          ) : kind === 'integer' || kind === 'decimal' ? (
                            <s-number-field
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              inputMode={kind === 'decimal' ? 'decimal' : 'numeric'}
                              step={kind === 'decimal' ? 0.01 : 1}
                              value={cell.value}
                              onInput={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLInputElement).value,
                                )
                              }
                            />
                          ) : (
                            <s-text-field
                              label={d.name}
                              labelAccessibilityVisibility="exclusive"
                              placeholder={
                                kind === 'date'
                                  ? 'YYYY-MM-DD'
                                  : kind === 'datetime'
                                    ? 'YYYY-MM-DDTHH:MM:SS'
                                    : undefined
                              }
                              value={cell.value}
                              onInput={(e: Event) =>
                                updateRowMetafield(
                                  index,
                                  d.id,
                                  (e.currentTarget as HTMLInputElement).value,
                                )
                              }
                            />
                          )}
                        </s-table-cell>
                      );
                    })}
                    {editInventory && (
                      <s-table-cell>
                        <s-number-field
                          label={INVENTORY_LABEL}
                          labelAccessibilityVisibility="exclusive"
                          inputMode="numeric"
                          step={1}
                          value={row.inventoryQty}
                          onInput={(e: Event) =>
                            updateRowInventory(index, (e.currentTarget as HTMLInputElement).value)
                          }
                        />
                      </s-table-cell>
                    )}
                    {editWeight && (
                      <s-table-cell>
                        <s-number-field
                          label={WEIGHT_LABEL}
                          labelAccessibilityVisibility="exclusive"
                          inputMode="decimal"
                          step={0.01}
                          value={row.weight}
                          onInput={(e: Event) =>
                            updateRowWeight(index, (e.currentTarget as HTMLInputElement).value)
                          }
                        />
                      </s-table-cell>
                    )}
                    {editImage && (
                      <s-table-cell>
                        <s-stack gap="small-300">
                          {row.image.selected ? (
                            <s-stack gap="small-300">
                              <s-thumbnail
                                size="small"
                                src={row.image.selected.thumbnailUrl}
                                alt={row.image.selected.alt || 'Selected image'}
                              />
                              <s-button variant="tertiary" onClick={() => clearRowImage(index)}>
                                Clear
                              </s-button>
                            </s-stack>
                          ) : (
                            <s-stack gap="small-300">
                              <s-search-field
                                label="Search files"
                                labelAccessibilityVisibility="exclusive"
                                placeholder="Search files by name"
                                value={row.image.searchTerm}
                                onInput={(e: Event) =>
                                  updateRowImage(index, {
                                    searchTerm: (e.currentTarget as HTMLInputElement).value,
                                  })
                                }
                              />
                              <s-button
                                loading={row.image.searching}
                                disabled={row.image.searchTerm.trim() === ''}
                                onClick={() => searchRowFiles(index, row.image.searchTerm)}
                              >
                                Search
                              </s-button>
                              {row.image.error && (
                                <s-text tone="critical">{row.image.error}</s-text>
                              )}
                              {!row.image.error &&
                                row.image.searched &&
                                !row.image.searching &&
                                row.image.results.length === 0 && (
                                  <s-text color="subdued">No files found</s-text>
                                )}
                              {row.image.results.length > 0 && (
                                <s-stack direction="inline" gap="small-300">
                                  {row.image.results.map((file) => (
                                    <s-clickable
                                      key={file.id}
                                      onClick={() => selectRowImage(index, file)}
                                      accessibilityLabel={`Select ${file.alt || 'image'}`}
                                    >
                                      <s-thumbnail
                                        size="small"
                                        src={file.thumbnailUrl}
                                        alt={file.alt || 'File image'}
                                      />
                                    </s-clickable>
                                  ))}
                                </s-stack>
                              )}
                            </s-stack>
                          )}
                        </s-stack>
                      </s-table-cell>
                    )}
                    <s-table-cell>
                      <s-tooltip id={`remove-tooltip-${index}`}>Remove</s-tooltip>
                      <s-button
                        interestFor={`remove-tooltip-${index}`}
                        icon="delete"
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Remove row ${index + 1}`}
                        onClick={() => removeRow(index)}
                      />
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
          <s-box padding="base">
            <s-button onClick={addRow} icon="plus">
              Add row
            </s-button>
          </s-box>
        </s-section>

        <s-stack direction="inline" gap="base" justifyContent="end">
          <s-button onClick={() => setStep('select')}>Back</s-button>
          <s-button
            variant="primary"
            loading={validating}
            disabled={!canPreview}
            onClick={validateAndPreview}
          >
            Preview changes
          </s-button>
        </s-stack>
      </s-page>
    );
  }

  if (step === 'preview') {
    return (
      <s-page heading="Review changes">
        {parseWarnings.length > 0 && (
          <s-banner tone="warning" heading="Some values could not be read">
            <s-stack gap="small-300">
              {parseWarnings.map((w, i) => (
                <s-text key={i}>{w}</s-text>
              ))}
            </s-stack>
          </s-banner>
        )}
        <s-section heading="Preview">
          <s-paragraph>
            Every change is checked by default. Uncheck any row you want to exclude, then confirm to
            apply. {checkedPreviewCount} of {previewRows.length} selected.
          </s-paragraph>
        </s-section>
        <s-section padding="none" accessibilityLabel="Preview of pending changes">
          <s-table>
            <s-table-header-row>
              <s-table-header>
                <s-checkbox
                  accessibilityLabel="Select all changes"
                  checked={allPreviewChecked}
                  indeterminate={somePreviewChecked}
                  onChange={(e: Event) =>
                    toggleAllPreview((e.currentTarget as HTMLInputElement).checked)
                  }
                />
              </s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Field</s-table-header>
              <s-table-header>Current value</s-table-header>
              <s-table-header>New value</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {previewRows.map((r) => (
                <s-table-row key={r.key}>
                  <s-table-cell>
                    <s-checkbox
                      accessibilityLabel={`Include ${r.fieldLabel} change for ${r.productTitle}`}
                      checked={r.checked}
                      onChange={(e: Event) =>
                        togglePreviewRow(r.key, (e.currentTarget as HTMLInputElement).checked)
                      }
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-text>{r.productTitle}</s-text>
                      {r.duplicateRole === 'winner' && (
                        <s-badge tone="warning">
                          ⚠ Duplicate ID — this row wins (last occurrence)
                        </s-badge>
                      )}
                      {r.duplicateRole === 'overridden' && (
                        <s-badge tone="warning">
                          ⚠ Duplicate ID — this row will be overridden
                        </s-badge>
                      )}
                      {(r.field === 'inventory' || r.field === 'weight') && r.variantCount > 1 && (
                        <s-badge tone="warning">
                          This product has {r.variantCount} variants — only the default variant's
                          inventory will be updated.
                        </s-badge>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.fieldLabel}</s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">
                      {r.currentValue === '' ? '(empty)' : r.currentValue}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {r.field === 'image' && r.newThumbnailUrl ? (
                      <s-stack gap="small-300">
                        <s-stack direction="inline" gap="small-300" alignItems="center">
                          <s-thumbnail size="small" src={r.newThumbnailUrl} alt="New image" />
                          <s-text>{r.newValue}</s-text>
                        </s-stack>
                        <s-text tone="info">
                          This image will be set as the featured image (replaces current featured
                          image).
                        </s-text>
                      </s-stack>
                    ) : (
                      <s-text>{r.newValue === '' ? '(empty)' : r.newValue}</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
        <s-stack gap="small">
          {checkedPreviewCount === 0 && (
            <s-text color="subdued">Select at least one change to apply.</s-text>
          )}
          <s-stack direction="inline" gap="base" justifyContent="end">
            <s-button onClick={() => setStep('grid')} disabled={applying}>
              Back
            </s-button>
            <s-button
              variant="primary"
              loading={applying}
              disabled={checkedPreviewCount === 0}
              onClick={applyChanges}
            >
              {applying
                ? `Applying ${applyProgress.done}/${applyProgress.total}`
                : 'Confirm and apply'}
            </s-button>
          </s-stack>
        </s-stack>
      </s-page>
    );
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const partialCount = results.filter((r) => r.status === 'partial').length;
  const failureCount = results.filter((r) => r.status === 'failed').length;

  return (
    <s-page heading="Results">
      <s-section heading="Summary">
        <s-paragraph>
          {successCount} succeeded, {partialCount} partial, {failureCount} failed out of{' '}
          {results.length} products.
        </s-paragraph>
      </s-section>
      <s-section padding="none" accessibilityLabel="Apply results per product">
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Details</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {results.map((r, i) => (
              <s-table-row key={i}>
                <s-table-cell>{r.productTitle}</s-table-cell>
                <s-table-cell>
                  <s-badge
                    tone={
                      r.status === 'success'
                        ? 'success'
                        : r.status === 'partial'
                          ? 'warning'
                          : 'critical'
                    }
                  >
                    {r.status === 'success'
                      ? 'Success'
                      : r.status === 'partial'
                        ? 'Partial'
                        : 'Failed'}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>
                  {r.status === 'success' ? (
                    <s-text color="subdued">Updated</s-text>
                  ) : r.status === 'partial' ? (
                    <s-text tone="caution">{r.error}</s-text>
                  ) : (
                    <s-text tone="critical">{r.error}</s-text>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      <s-stack direction="inline" gap="base" justifyContent="end">
        <s-button variant="primary" onClick={startOver}>
          Start over
        </s-button>
      </s-stack>
    </s-page>
  );
}

export default (): void => render(<Extension />, document.body);
