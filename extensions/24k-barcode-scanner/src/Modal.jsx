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

function normalizeBarcode(value) {
  return String(value || '').trim();
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
  const response = await fetch('shopify:admin/api/graphql.json', {
    method: 'POST',
    body: JSON.stringify({query, variables}),
  });
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((error) => error.message).join(', '));
  return json.data;
}

function addBarcodeToIndex(index, conflicts, barcode, variant, matchType) {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return;

  const title = variantDisplayTitle(variant);
  const existing = index[normalized];

  if (existing && existing.variantGid !== variant.id) {
    conflicts.push({barcode: normalized, firstTitle: existing.title, secondTitle: title});
    return;
  }

  index[normalized] = {
    barcode: normalized,
    variantGid: variant.id,
    variantNumericId: variantNumericIdFromGid(variant.id),
    title,
    sku: variant.sku || null,
    matchType,
  };
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
  const processingRef = useRef(false);
  const lastScanRef = useRef({barcode: '', timestamp: 0});

  useEffect(() => {
    initialize();
    const unsubscribe = shopify.scanner.scannerData.current.subscribe(async (scan) => {
      const barcode = normalizeBarcode(scan.data);
      if (!barcode) return;
      const now = Date.now();
      const lastScan = lastScanRef.current;
      if (lastScan.barcode === barcode && now - lastScan.timestamp < 1200) return;
      lastScanRef.current = {barcode, timestamp: now};
      await handleBarcode(barcode);
    });
    return () => {
      unsubscribe();
      shopify.scanner.hideCameraScanner();
    };
  }, []);

  async function initialize() {
    setLoading(true);
    setError('');
    setLastFound(null);
    setLastNotFound('');
    setStatus('Loading barcode data from Shopify...');

    try {
      const built = await buildBarcodeIndex();
      if (built.conflicts.length > 0) {
        const conflict = built.conflicts[0];
        setError(`Duplicate barcode conflict: ${conflict.barcode} is assigned to both ${conflict.firstTitle} and ${conflict.secondTitle}. Fix this in Multi-Barcode Manager.`);
        setLoading(false);
        return;
      }
      if (built.barcodeCount === 0) {
        setError('No barcodes found. Check that products have native barcodes or alternate barcodes saved in custom.alternate_barcodes.');
        setLoading(false);
        return;
      }
      setBarcodeIndex(built.index);
      setStatus(`Ready. Loaded ${built.barcodeCount} barcodes from ${built.variantCount} variants.`);
      setLoading(false);
      shopify.scanner.showCameraScanner();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load barcode data.');
      setLoading(false);
    }
  }

  async function handleBarcode(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode || !barcodeIndex || processingRef.current) return;

    setLastFound(null);
    setLastNotFound('');
    setError('');

    const match = barcodeIndex[barcode];
    if (!match) {
      setLastNotFound(barcode);
      setStatus(`Not found: ${barcode}`);
      shopify.toast.show(`Barcode not found: ${barcode}`);
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
      setStatus(`Added: ${match.title}`);
      shopify.toast.show(`Added: ${match.title}`);
      shopify.scanner.showCameraScanner();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add product to cart.');
    } finally {
      processingRef.current = false;
    }
  }

  async function handleManualSubmit() {
    const barcode = normalizeBarcode(manualBarcode);
    setManualBarcode('');
    await handleBarcode(barcode);
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
          el('s-banner', {tone: 'critical', heading: 'Scanner error'}, error),
          el('s-button', {variant: 'primary', onClick: initialize}, 'Reload barcode data'),
          el('s-button', {variant: 'secondary', onClick: () => shopify.scanner.hideCameraScanner()}, 'Stop scanner'),
        ),
      ),
    );
  }

  return el('s-page', {heading: '24K Barcode Scanner'},
    el('s-section', null,
      el('s-stack', {direction: 'block', gap: 'base'},
        el('s-banner', {tone: 'info', heading: 'Scan products here'}, 'Use this scanner when Shopify POS does not recognize a product barcode.'),
        el('s-text', null, status),
        lastFound && el('s-banner', {tone: 'success', heading: 'Added to cart'}, lastFound.title),
        lastNotFound && el('s-banner', {tone: 'critical', heading: 'Barcode not found'}, lastNotFound),
        el('s-text-field', {
          label: 'Manual barcode',
          value: manualBarcode,
          placeholder: 'Enter UPC manually',
          autocomplete: 'off',
          onInput: (event) => setManualBarcode(event.target.value),
        }),
        el('s-button', {variant: 'primary', disabled: !normalizeBarcode(manualBarcode), onClick: handleManualSubmit}, 'Add by manual barcode'),
        el('s-button', {variant: 'secondary', onClick: () => shopify.scanner.showCameraScanner()}, 'Open camera scanner'),
        el('s-button', {variant: 'secondary', onClick: initialize}, 'Reload barcode data'),
      ),
    ),
  );
}

export default async () => {
  render(h(Extension, null), document.body);
};
