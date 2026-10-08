// Presets de proveedores de tiles públicos. Son DATOS, no un code-path: se asignan a `map.tile` directo, o
// spread con overrides (`{ ...tilePresets.osm, maxZoom: 17 }`). La key de un proveedor que la pide la pone
// el consumidor en la URL — no la horneamos acá para no esconder la key ni opinar.
export const tilePresets = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19, attribution: '© OpenStreetMap',
  },
  cartoLight: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap, © CARTO',
  },
  cartoDark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap, © CARTO',
  },
  esriImagery: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19, attribution: '© Esri',
  },
}
