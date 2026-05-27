import {h, render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import '@shopify/ui-extensions/preact';

const FETCH_VARIANTS_QUERY = `#graphql
  query FetchVariantsForBarcodeScanner($after: String) {
    productVariants(first: 250, after: $after) {
      edges {
        node {
          id
          title
          barcode
          sku
          product { title }
          alternateBarcodes: metafield(namespace: "custom", key: "alternate_barcodes") { jsonValue }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const MIN_AUTO_SUBMIT_LENGTH = 8;
const AUTO_SUBMIT_DELAY_MS = 500;
const DUPLICATE_SCAN_WINDOW_MS = 1200;

function normalizeBarcode(value) {
  return String(value || '').replace(/[\r\n\t]/g, '').trim();
}

function parseAlternateBarcodes(jsonValue) {
  if (!Array.isArray(jsonValue)) return [];
  return jsonValue.filter((value) => typeof value === 'string').map(normalizeBarcode).filter(Boolean);
}

function variantDisplayTitle(variant) {
  return variant.title === 'Default Title' ? variant.product.title : `${variant.product.title} - ${variant.title}`;
}

function variantNumericIdFromGid(gid) {
  const numericId = Number(String(gid || '').split('/').pop());
  if (!Number.isFinite(numericId)) throw new Error(`Invalid Shopify variant ID: ${gid}`);
  return numericId;
}

async function adminGraphQL(query, variables = {}) {
  let response;
  try {
    response = await fetch('shopify:admin/api/graphql.json', {
      method: 'POST',
      body: JSON.stringify({query, variables}),
    });
  } catch (err) {
    throw new Error(`Direct Admin API request failed before response: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Direct Admin API returned non-JSON response. Status ${response.status}. Body: ${text.slice(0, 250)}`);
  }

  if (!response.ok) {
    throw new Error(`Direct Admin API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 350)}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors.map((error) => error.message).join(', ')}`);
  }

  return json.data;
}

function addBarcodeToIndex(index, conflicts, barcode, variant, matchType) {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return;

  const title = variantDisplayTitle(variant);
  const existing = index[normalized];

  if (existing && existing.variantGid !== variant.id) {
    conflicts.push({barcode: normalized, firstTitle: existing.title, secondTitle: title});
    delete index[normalized];
    return;
  }

  if (!existing) {
    index[normalized] = {
      barcode: normalized,
      variantGid: variant.id,
      variantNumericId: variantNumericIdFromGid(variant.id),
      title,
      sku: variant.sku || null,
      matchType,
    };
  }
}

async function buildBarcodeIndex() {
  const index = {};
  const conflicts = [];
  let after = null;
  let variantCount = 0;

  do {
    const data = await adminGraphQL(FETCH_VARIANTS_QUERY, {after});
    const edges = data?.productVariants?.edges || [];

    for (const edge of edges) {
      const variant = edge.node;
      variantCount += 1;
      addBarcodeToIndex(index, conflicts, variant.barcode, variant, 'native');
      for (const alt of parseAlternateBarcodes(variant.alternateBarcodes?.jsonValue)) {
        addBarcodeToIndex(index, conflicts, alt, variant, 'alternate');
      }
    }

    after = data?.productVariants?.pageInfo?.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);

  return {index, conflicts, variantCount, barcodeCount: Object.keys(index).length};
}

function el(tag, props, ...children) {
  return h(tag, props || {}, ...children.filter((child) => child !== null && child !== undefined && child !== false));
}

function Extension() {
  const [loading, setLoading] = useState(true);
  const [barcodeIndex, setBarcodeIndex] = useState(null);
  const [manualBarcode, setManualBarcode] = useState('');
  const [status, setStatus] = useState('Loading barcode data...');
  const [error, setError] = useState('');
  const [lastFound, setLastFound] = useState(null);
  const [lastNotFound, setLastNotFound] = useState('');
  const [warning, setWarning] = useState('');
  const inputRef = useRef(null);
  const currentInputRef = useRef('');
  const autoSubmitTimerRef = useRef(null);
  const focusAssistTimerRef = useRef(null);
  const processingRef = useRef(false);
  const lastScanRef = useRef({barcode: '', timestamp: 0});

  useEffect(() => {
    initialize();
    const unsubscribe = shopify.scanner.scannerData.current.subscribe(async (scan) => {
      const barcode = normalizeBarcode(scan.data);
      if (!barcode) return;
      await processBarcode(barcode);
    });
    return () => {
      if (autoSubmitTimerRef.current) clearTimeout(autoSubmitTimerRef.current);
      if (focusAssistTimerRef.current) clearInterval(focusAssistTimerRef.current);
      unsubscribe();
      shopify.scanner.hideCameraScanner();
    };
  }, []);

  useEffect(() => {
    if (!loading && !error) startFocusAssist();
  }, [loading, error, barcodeIndex]);

  function focusScannerInput() {
    try {
      inputRef.current?.focus?.();
      inputRef.current?.select?.();
    } catch (_err) {
      // POS UI extension hosts do not always expose focus/select. Safe to ignore.
    }
  }

  function startFocusAssist() {
    let attempts = 0;
    if (focusAssistTimerRef.current) clearInterval(focusAssistTimerRef.current);
    focusScannerInput();
    focusAssistTimerRef.current = setInterval(() => {
      attempts += 1;
      focusScannerInput();
      if (attempts >= 10) {
        clearInterval(focusAssistTimerRef.current);
        focusAssistTimerRef.current = null;
      }
    }, 250);
  }

  function resetInput() {
    currentInputRef.current = '';
    setManualBarcode('');
  }

  function scheduleAutoSubmit(rawValue) {
    const rawString = String(rawValue || '');
    const barcode = normalizeBarcode(rawString);
    currentInputRef.current = barcode;

    if (autoSubmitTimerRef.current) clearTimeout(autoSubmitTimerRef.current);
    if (barcode.length < MIN_AUTO_SUBMIT_LENGTH) return;

    const hasScannerTerminator = /[\r\n]/.test(rawString);
    const delay = hasScannerTerminator ? 0 : AUTO_SUBMIT_DELAY_MS;

    autoSubmitTimerRef.current = setTimeout(async () => {
      const latest = normalizeBarcode(currentInputRef.current);
      if (latest.length < MIN_AUTO_SUBMIT_LENGTH) return;
      resetInput();
      await processBarcode(latest);
      startFocusAssist();
    }, delay);
  }

  async function initialize() {
    setLoading(true);
    setError('');
    setWarning('');
    setLastFound(null);
    setLastNotFound('');
    setStatus('Loading barcode data from Shopify...');

    try {
      const built = await buildBarcodeIndex();
      if (built.barcodeCount === 0) {
        setError('No barcodes found. Check that products have native barcodes or alternate barcodes saved in custom.alternate_barcodes.');
        setLoading(false);
        return;
      }
      setBarcodeIndex(built.index);
      if (built.conflicts.length > 0) {
        const conflict = built.conflicts[0];
        setWarning(`${built.conflicts.length} duplicate barcode conflict(s) ignored. Example: ${conflict.barcode} belongs to both ${conflict.firstTitle} and ${conflict.secondTitle}. Fix duplicates in Multi-Barcode Manager.`);
      }
      setStatus(`Ready to scan. Loaded ${built.barcodeCount} usable barcodes.`);
      setLoading(false);
      startFocusAssist();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unknown error: ${String(err)}`);
      setLoading(false);
    }
  }

  async function processBarcode(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode || !barcodeIndex || processingRef.current) return;

    const now = Date.now();
    const lastScan = lastScanRef.current;
    if (lastScan.barcode === barcode && now - lastScan.timestamp < DUPLICATE_SCAN_WINDOW_MS) return;
    lastScanRef.current = {barcode, timestamp: now};

    await handleBarcode(barcode);
  }

  async function handleBarcode(barcode) {
    setLastFound(null);
    setLastNotFound('');
    setError('');

    const match = barcodeIndex[barcode];
    if (!match) {
      setLastNotFound(barcode);
      setStatus(`Not found: ${barcode}`);
      shopify.toast.show(`Barcode not found: ${barcode}`);
      startFocusAssist();
      return;
    }

    processingRef.current = true;
    setStatus(`Adding ${match.title}...`);

    try {
      const lineUuid = await shopify.cart.addLineItem(match.variantNumericId, 1);
      if (!lineUuid) {
        setError('Product was found, but Shopify POS did not add it. The oversell warning may have been dismissed.');
        return;
      }
      setLastFound(match);
      setStatus('Ready for next scan.');
      shopify.toast.show(`Added: ${match.title}`);
      startFocusAssist();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to add product to cart: ${String(err)}`);
    } finally {
      processingRef.current = false;
    }
  }

  async function handleManualSubmit() {
    const barcode = normalizeBarcode(currentInputRef.current || manualBarcode);
    resetInput();
    await processBarcode(barcode);
    startFocusAssist();
  }

  if (loading) {
    return el('s-page', {heading: '24K Barcode Scanner'},
      el('s-section', null,
        el('s-stack', {direction: 'block', gap: 'base'},
          el('s-spinner'),
          el('s-text', null, status),
        ),
      ),
    );
  }

  if (error) {
    return el('s-page', {heading: '24K Barcode Scanner'},
      el('s-section', null,
        el('s-stack', {direction: 'block', gap: 'base'},
          el('s-banner', {tone: 'critical', heading: 'Scanner error'}, 'Open details below.'),
          el('s-text', null, error),
          el('s-text', {color: 'subdued'}, 'This error happened while loading barcode data from Shopify.'),
          el('s-button', {variant: 'primary', onClick: initialize}, 'Reload barcode data'),
        ),
      ),
    );
  }

  return el('s-page', {heading: '24K Barcode Scanner'},
    el('s-section', null,
      el('s-stack', {direction: 'block', gap: 'base'},
        warning && el('s-banner', {tone: 'warning', heading: 'Duplicate barcodes ignored'}, warning),
        el('s-text', null, status),
        lastFound && el('s-banner', {tone: 'success', heading: 'Added to cart'}, lastFound.title),
        lastNotFound && el('s-banner', {tone: 'critical', heading: 'Barcode not found'}, lastNotFound),
        el('s-text-field', {
          ref: inputRef,
          label: 'Scan or enter barcode',
          value: manualBarcode,
          placeholder: 'Ready for scanner input',
          autocomplete: 'off',
          inputMode: 'text',
          onInput: (event) => {
            const value = event.target.value;
            currentInputRef.current = normalizeBarcode(value);
            setManualBarcode(value);
            scheduleAutoSubmit(value);
          },
          onKeyDown: async (event) => {
            if (event.key === 'Enter') {
              event.preventDefault?.();
              await handleManualSubmit();
            }
          },
        }),
        el('s-button', {variant: 'primary', disabled: !normalizeBarcode(manualBarcode), onClick: handleManualSubmit}, 'Add barcode'),
        el('s-button', {variant: 'secondary', onClick: initialize}, 'Reload barcode data'),
      ),
    ),
  );
}

export default async () => {
  render(h(Extension, null), document.body);
};
