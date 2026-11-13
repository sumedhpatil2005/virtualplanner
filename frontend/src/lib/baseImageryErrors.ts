/**
 * Base-map imagery (Cesium ion / the base-layer picker) is created asynchronously by Cesium. When that creation fails
 * (no network, an invalid or missing ion token: HTTP 401) Cesium logs the raw RequestErrorEvent to the console unless the
 * layer's errorEvent has a listener. We listen, and tell the user once in words instead.
 */
interface ErrorEventLike { addEventListener(fn: (err: unknown) => void): unknown }
interface LayerLike { errorEvent?: ErrorEventLike; isBaseLayer?: () => boolean }
interface LayerCollectionLike { length: number; get(i: number): LayerLike; layerAdded: { addEventListener(fn: (layer: LayerLike) => void): () => void } }

function statusOf(err: unknown): unknown { return (err as { statusCode?: unknown } | null)?.statusCode; }

/** The lasting map notice: why there is no base imagery, in a few words. */
export function baseImageryNotice(err: unknown): string {
  const status = statusOf(err);
  const why = status === 401 || status === 403 ? `access refused (HTTP ${status})` : typeof status === 'number' ? `HTTP ${status}` : 'no response';
  return `No base imagery: ${why}. City data is unaffected.`;
}

export function baseImageryErrorMessage(err: unknown): string {
  const status = statusOf(err);
  const why = status === 401 || status === 403 ? `access refused (HTTP ${status}); check VITE_CESIUM_ION_TOKEN`
    : typeof status === 'number' ? `HTTP ${status}` : 'no response; check the connection';
  return `Base map imagery could not be loaded (${why}). The map is shown without satellite imagery; city data is unaffected.`;
}

/** Attaches an error listener to every current and future imagery layer; notify runs at most once per watcher. Returns the unsubscribe. */
export function watchImageryErrors(layers: LayerCollectionLike, notify: (message: string) => void): () => void {
  let told = false;
  const seen = new WeakSet<object>();
  const watch = (layer: LayerLike) => {
    if (!layer?.errorEvent || seen.has(layer)) return;
    seen.add(layer);
    layer.errorEvent.addEventListener(err => {
      if (told) return;
      told = true;
      notify(baseImageryErrorMessage(err));
    });
  };
  for (let i = 0; i < layers.length; i++) watch(layers.get(i));
  return layers.layerAdded.addEventListener(watch);
}

/**
 * The base map's state for a lasting notice on the map (the toast above goes after a few seconds and left a plain blue
 * globe unexplained): `onState(notice)` when the base layer fails, `onState(null)` when another base layer is put in
 * its place (the base-layer picker), so the notice never outlives the failure it reports. Overlay layers (environment,
 * terrain) do not touch it. Returns the unsubscribe.
 */
export function watchBaseImageryState(layers: LayerCollectionLike, onState: (message: string | null) => void): () => void {
  let current: LayerLike | null = null;
  const watch = (layer: LayerLike) => {
    if (!layer?.errorEvent || layer === current) return;
    current = layer;
    onState(null);
    layer.errorEvent.addEventListener(err => { if (current === layer) onState(baseImageryNotice(err)); });
  };
  if (layers.length > 0) watch(layers.get(0));
  return layers.layerAdded.addEventListener(layer => { if (layer?.isBaseLayer?.()) watch(layer); });
}
