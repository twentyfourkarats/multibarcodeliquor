const API = 'shopify:admin/api/graphql.json';
const app = document.getElementById('app');

const state = {
  setupDone: false,
  setupWarning: '',
  searchInput: '',
  searchTerm: '',
  variants: [],
  pageInfo: null,
  cursorStack: [],
  searching: false,
  searchError: '',
  hasSearched: false,
  selected: null,
  newBarcode: '',
  saveError: '',
  saveSuccess: '',
  saveWarning: '',
  bulkMode: false,
  selectedIds: new Set(),
  bulkVariants: [],
  inBulkEdit: false,
  debounce: null,
};

const CHECK_METAFIELD_DEFINITION_QUERY = `query CheckMetafieldDefinition { metafieldDefinition(identifier: { ownerType: PRODUCTVARIANT namespace: "custom" key: "alternate_barcodes" }) { id } }`;
const CREATE_METAFIELD_DEFINITION_MUTATION = `mutation CreateBarcodeMetafieldDefinition($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id name } userErrors { field message code } } }`;
const SEARCH_VARIANTS_QUERY = `query SearchVariants($query: String!, $after: String) { productVariants(first: 25, query: $query, after: $after) { edges { node { id title barcode sku product { id title featuredMedia { ... on MediaImage { preview { image { url } } } } } alternateBarcodes: metafield(namespace: "custom", key: "alternate_barcodes") { jsonValue } } } pageInfo { hasNextPage endCursor hasPreviousPage startCursor } } }`;
const SET_ALTERNATE_BARCODES_MUTATION = `mutation SetAlternateBarcodes($ownerId: ID!, $value: String!) { metafieldsSet(metafields: [{ ownerId: $ownerId namespace: "custom" key: "alternate_barcodes" type: "list.single_line_text_field" value: $value }]) { metafields { id jsonValue } userErrors { field message code } } }`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseAlternateBarcodes(jsonValue) {
  return Array.isArray(jsonValue) ? jsonValue.filter(v => typeof v === 'string') : [];
}

function variantDisplayTitle(v) {
  return v.title === 'Default Title' ? v.product.title : `${v.product.title} – ${v.title}`;
}

function mapVariant(node) {
  return {
    id: node.id,
    title: node.title,
    barcode: node.barcode || null,
    sku: node.sku || null,
    product: node.product,
    alternateBarcodes: parseAlternateBarcodes(node.alternateBarcodes?.jsonValue),
  };
}

function diagnostics() {
  return `embedded=${window.self !== window.top}, shopify=${Boolean(window.shopify)}, meta=${Boolean(document.querySelector('meta[name="shopify-api-key"]'))}, script=${Boolean(document.querySelector('script[src*="app-bridge.js"]'))}, href=${window.location.href}`;
}

async function adminGraphQL(query, variables = {}) {
  let response;
  try {
    response = await fetch(API, { method: 'POST', body: JSON.stringify({ query, variables }) });
  } catch (err) {
    throw new Error(`Could not reach Shopify Admin API. Open this app from Shopify Admin. [${diagnostics()}]`);
  }
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Error(`Shopify returned non-JSON. Status ${response.status}. ${text.slice(0, 200)}`); }
  if (!response.ok) throw new Error(`Shopify Admin API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join(', '));
  return json.data;
}

async function ensureMetafieldDefinition() {
  try {
    const data = await adminGraphQL(CHECK_METAFIELD_DEFINITION_QUERY);
    if (data?.metafieldDefinition?.id) return;
    const created = await adminGraphQL(CREATE_METAFIELD_DEFINITION_MUTATION, { definition: { name: 'Alternate Barcodes', namespace: 'custom', key: 'alternate_barcodes', type: 'list.single_line_text_field', ownerType: 'PRODUCTVARIANT', access: { storefront: 'NONE' } } });
    const errs = created?.metafieldDefinitionCreate?.userErrors || [];
    if (errs.length) state.setupWarning = errs.map(e => e.field ? `${e.field}: ${e.message}` : e.message).join(', ');
  } catch (err) {
    state.setupWarning = `Could not verify metafield definition: ${err.message}`;
  } finally {
    state.setupDone = true;
    render();
  }
}

function validateBarcodeInput(raw, nativeBarcode, existingAlternates) {
  const candidates = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!candidates.length) return { valid: [], skippedNative: [], skippedDuplicate: [], empty: true };
  const valid = [], skippedNative = [], skippedDuplicate = [], seen = new Set();
  for (const bc of candidates) {
    if (seen.has(bc)) { skippedDuplicate.push(bc); continue; }
    seen.add(bc);
    if (nativeBarcode && bc === nativeBarcode) skippedNative.push(bc);
    else if (existingAlternates.includes(bc)) skippedDuplicate.push(bc);
    else valid.push(bc);
  }
  return { valid, skippedNative, skippedDuplicate, empty: false };
}

function buildSkipWarning(native, dupes) {
  const parts = [];
  if (native.length) parts.push(`Already set as native barcode: ${native.join(', ')}`);
  if (dupes.length) parts.push(`Already in alternate list: ${dupes.join(', ')}`);
  return parts.join(' | ');
}

async function performSearch(term, cursor = null, pushCursor = false) {
  state.searching = true; state.searchError = ''; state.selected = null; render();
  try {
    const data = await adminGraphQL(SEARCH_VARIANTS_QUERY, { query: term, after: cursor });
    state.variants = (data?.productVariants?.edges || []).map(e => mapVariant(e.node));
    state.pageInfo = data?.productVariants?.pageInfo || null;
    state.hasSearched = true;
    if (pushCursor && cursor) state.cursorStack.push(cursor);
  } catch (err) {
    state.searchError = err.message || 'Search failed.'; state.variants = []; state.hasSearched = true;
  } finally { state.searching = false; render(); }
}

async function saveBarcodes(variantId, barcodes) {
  const data = await adminGraphQL(SET_ALTERNATE_BARCODES_MUTATION, { ownerId: variantId, value: JSON.stringify(barcodes) });
  const errs = data?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(errs.map(e => e.field ? `${e.field}: ${e.message}` : e.message).join(', '));
}

async function addBarcodesToVariant(variant, raw, opts = {}) {
  const result = validateBarcodeInput(raw, variant.barcode, variant.alternateBarcodes);
  if (result.empty) throw new Error('Please enter at least one barcode value.');
  if (!result.valid.length) throw new Error(buildSkipWarning(result.skippedNative, result.skippedDuplicate) || 'All entered barcodes already exist for this variant.');
  const updated = [...variant.alternateBarcodes, ...result.valid];
  await saveBarcodes(variant.id, updated);
  variant.alternateBarcodes = updated;
  syncVariant(variant);
  const skip = buildSkipWarning(result.skippedNative, result.skippedDuplicate);
  if (!opts.silent) {
    state.saveSuccess = `${result.valid.length} barcode${result.valid.length !== 1 ? 's' : ''} added successfully.`;
    state.saveWarning = skip ? `Some barcodes were skipped — ${skip}` : '';
  }
}

async function deleteBarcodeFromVariant(variant, barcode) {
  const original = [...variant.alternateBarcodes];
  variant.alternateBarcodes = original.filter(b => b !== barcode);
  syncVariant(variant); render();
  try {
    await saveBarcodes(variant.id, variant.alternateBarcodes);
    state.saveSuccess = 'Barcode deleted.';
  } catch (err) {
    variant.alternateBarcodes = original; syncVariant(variant); state.saveError = err.message;
  }
  render();
}

function syncVariant(updated) {
  state.variants = state.variants.map(v => v.id === updated.id ? {...updated} : v);
  state.bulkVariants = state.bulkVariants.map(v => v.id === updated.id ? {...updated} : v);
  if (state.selected?.id === updated.id) state.selected = {...updated};
}

function productCell(v) {
  const img = v.product.featuredMedia?.preview?.image?.url;
  return `<div class="product-cell">${img ? `<img class="thumb" src="${esc(img)}" alt="">` : ''}<strong>${esc(variantDisplayTitle(v))}</strong></div>`;
}

function renderSearch() {
  return `<div class="app-shell"><div class="header"><h1>Multi-Barcode Manager</h1><p>Search for a product or variant to view and manage its barcodes. Alternate barcodes are stored as variant metafields and can be read by the POS scanner.</p></div>${state.setupWarning ? `<div class="banner warning"><strong>Setup warning:</strong> ${esc(state.setupWarning)}</div>` : ''}<div class="card"><label>Search products and variants</label><input id="search" type="search" placeholder="Search by product name, variant title, SKU, or barcode…" value="${esc(state.searchInput)}"></div>${state.searchError ? `<div class="banner critical">${esc(state.searchError)}</div>` : ''}${renderResults()}</div>`;
}

function renderResults() {
  if (!state.hasSearched && !state.searching) return `<div class="card stack" style="text-align:center"><h2>Search for a product or variant</h2><p>Use the search field above to find a product or variant by name, SKU, or barcode.</p></div>`;
  return `<div class="card"><div class="row-between"><h2>${state.searching ? 'Searching…' : `Results for "${esc(state.searchTerm)}"`}</h2>${state.variants.length ? `<button id="bulkToggle">${state.bulkMode ? 'Cancel bulk edit' : 'Bulk edit'}</button>` : ''}${state.bulkMode && state.selectedIds.size ? `<button class="primary" id="editSelected">Edit ${state.selectedIds.size} selected</button>` : ''}</div><div class="table-wrap"><table><thead><tr>${state.bulkMode ? '<th><input type="checkbox" id="selectAll"></th>' : ''}<th>Product / Variant</th><th>Native barcode</th><th>SKU</th><th>Alternate barcodes</th>${!state.bulkMode ? '<th>Manage</th>' : ''}</tr></thead><tbody>${state.variants.length ? state.variants.map(v => `<tr>${state.bulkMode ? `<td><input type="checkbox" class="sel" data-id="${esc(v.id)}" ${state.selectedIds.has(v.id) ? 'checked' : ''}></td>` : ''}<td>${productCell(v)}</td><td>${esc(v.barcode || 'None')}</td><td>${esc(v.sku || '—')}</td><td><span class="badge ${v.alternateBarcodes.length ? 'success' : ''}">${v.alternateBarcodes.length}</span></td>${!state.bulkMode ? `<td><button data-manage="${esc(v.id)}">Manage barcodes</button></td>` : ''}</tr>`).join('') : `<tr><td colspan="6" class="muted">No variants found.</td></tr>`}</tbody></table></div><div class="row" style="margin-top:12px"><button id="prevPage" ${!state.cursorStack.length ? 'disabled' : ''}>Previous</button><button id="nextPage" ${!state.pageInfo?.hasNextPage ? 'disabled' : ''}>Next</button></div></div>`;
}

function renderDetail() {
  const v = state.selected; const img = v.product.featuredMedia?.preview?.image?.url;
  return `<div class="app-shell"><div class="card"><button id="back">Back to search results</button></div><div class="card row"><div>${img ? `<img class="thumb" style="width:72px;height:72px" src="${esc(img)}" alt="">` : ''}</div><div><h1>${esc(variantDisplayTitle(v))}</h1><p>SKU: ${esc(v.sku || '—')}</p></div></div>${state.saveError ? `<div class="banner critical">${esc(state.saveError)}</div>` : ''}${state.saveSuccess ? `<div class="banner success">${esc(state.saveSuccess)}</div>` : ''}${state.saveWarning ? `<div class="banner warning">${esc(state.saveWarning)}</div>` : ''}<div class="card"><h2>All barcodes</h2><div class="barcode-list"><div class="barcode-item"><div><strong>${esc(v.barcode || 'No native barcode set')}</strong> <span class="badge info">Native</span><div class="muted small">Edit in product settings</div></div></div>${v.alternateBarcodes.map(b => `<div class="barcode-item"><div><strong>${esc(b)}</strong> <span class="badge">Alternate</span></div><button class="danger" data-delete="${esc(b)}">Delete</button></div>`).join('') || '<p class="muted">No alternate barcodes added yet.</p>'}</div></div><div class="card"><h2>Add alternate barcode</h2><div class="grid2"><div><label>New barcode(s)</label><input id="newBarcode" type="text" placeholder="Enter one or more barcodes, comma-separated" value="${esc(state.newBarcode)}"></div><button class="primary" id="addBarcode">Add barcode</button></div></div></div>`;
}

function renderBulkEdit() {
  return `<div class="app-shell"><div class="card row-between"><div><h1>Bulk Barcode Edit</h1><p>Editing ${state.bulkVariants.length} variant${state.bulkVariants.length !== 1 ? 's' : ''}. Changes save immediately per variant.</p></div><button class="primary" id="doneBulk">Done</button></div>${state.bulkVariants.map(v => `<div class="card bulk-row" data-id="${esc(v.id)}"><div class="row-between"><div>${productCell(v)}<p class="muted small">Native barcode: ${esc(v.barcode || '—')} ${v.sku ? ` | SKU: ${esc(v.sku)}` : ''}</p></div></div><div class="barcode-list">${v.alternateBarcodes.map(b => `<div class="barcode-item"><span>${esc(b)}</span><button class="danger" data-bulk-delete="${esc(v.id)}|||${esc(b)}">Delete</button></div>`).join('') || '<p class="muted">No alternate barcodes yet.</p>'}</div><div class="grid2" style="margin-top:12px"><input type="text" data-bulk-input="${esc(v.id)}" placeholder="Enter one or more barcodes, comma-separated"><button class="primary" data-bulk-add="${esc(v.id)}">Add</button></div></div>`).join('')}</div>`;
}

function render() {
  if (!state.setupDone) app.innerHTML = `<div class="app-shell"><div class="card row"><strong>Initializing barcode manager…</strong></div></div>`;
  else if (state.inBulkEdit) app.innerHTML = renderBulkEdit();
  else if (state.selected) app.innerHTML = renderDetail();
  else app.innerHTML = renderSearch();
  bind();
}

function bind() {
  const search = document.getElementById('search');
  if (search) search.addEventListener('input', e => { state.searchInput = e.target.value; clearTimeout(state.debounce); state.debounce = setTimeout(() => { state.searchTerm = state.searchInput.trim(); state.cursorStack = []; if (!state.searchTerm) { state.variants = []; state.hasSearched = false; render(); } else performSearch(state.searchTerm); }, 400); });
  document.querySelectorAll('[data-manage]').forEach(btn => btn.addEventListener('click', () => { state.selected = {...state.variants.find(v => v.id === btn.dataset.manage)}; state.saveError=''; state.saveSuccess=''; state.saveWarning=''; state.newBarcode=''; render(); }));
  document.getElementById('back')?.addEventListener('click', () => { state.selected = null; render(); });
  document.getElementById('addBarcode')?.addEventListener('click', async () => { state.newBarcode = document.getElementById('newBarcode').value; state.saveError=''; state.saveSuccess=''; state.saveWarning=''; try { await addBarcodesToVariant(state.selected, state.newBarcode); state.newBarcode=''; } catch (err) { state.saveError = err.message; } render(); });
  document.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', () => deleteBarcodeFromVariant(state.selected, btn.dataset.delete)));
  document.getElementById('bulkToggle')?.addEventListener('click', () => { state.bulkMode = !state.bulkMode; state.selectedIds = new Set(); render(); });
  document.querySelectorAll('.sel').forEach(cb => cb.addEventListener('change', () => { cb.checked ? state.selectedIds.add(cb.dataset.id) : state.selectedIds.delete(cb.dataset.id); render(); }));
  document.getElementById('selectAll')?.addEventListener('change', e => { state.selectedIds = e.target.checked ? new Set(state.variants.map(v => v.id)) : new Set(); render(); });
  document.getElementById('editSelected')?.addEventListener('click', () => { state.bulkVariants = state.variants.filter(v => state.selectedIds.has(v.id)).map(v => ({...v, alternateBarcodes:[...v.alternateBarcodes]})); state.inBulkEdit = true; render(); });
  document.getElementById('doneBulk')?.addEventListener('click', () => { state.inBulkEdit=false; state.bulkMode=false; state.selectedIds=new Set(); state.bulkVariants=[]; render(); });
  document.querySelectorAll('[data-bulk-add]').forEach(btn => btn.addEventListener('click', async () => { const v = state.bulkVariants.find(x => x.id === btn.dataset.bulkAdd); const input = document.querySelector(`[data-bulk-input="${CSS.escape(v.id)}"]`); try { await addBarcodesToVariant(v, input.value, {silent:true}); input.value=''; render(); } catch (err) { alert(err.message); } }));
  document.querySelectorAll('[data-bulk-delete]').forEach(btn => btn.addEventListener('click', async () => { const [id, barcode] = btn.dataset.bulkDelete.split('|||'); const v = state.bulkVariants.find(x => x.id === id); await deleteBarcodeFromVariant(v, barcode); }));
  document.getElementById('nextPage')?.addEventListener('click', () => state.pageInfo?.endCursor && performSearch(state.searchTerm, state.pageInfo.endCursor, true));
  document.getElementById('prevPage')?.addEventListener('click', () => { state.cursorStack.pop(); const prev = state.cursorStack[state.cursorStack.length - 1] || null; performSearch(state.searchTerm, prev); });
}

render();
ensureMetafieldDefinition();
