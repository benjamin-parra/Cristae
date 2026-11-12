// Los proveedores de tiles de altura que la librería nombra: datos y nada más, sin imports, para que quien
// sólo quiere un preset no cargue el terreno ni su cargador de tiles.

// Proveedores públicos, sin key ni cuenta. Los dos cargan la misma grilla, 2^20 píxeles por vuelta: AWS
// a z12 con tiles de 256 y Mapterhorn a z11 con tiles de 512. Son 1,24″ por píxel, 38 m en el ecuador:
// cerca del 1″ de SRTM y de GLO-30, sin llegar a él.
export const terrainPresets = {
  aws: {
    url         : 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding    : 'terrarium',
    zoom        : 12,
    maxZoom     : 15,
    tileSize    : 256,
    attribution : 'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
  },
  mapterhorn: {
    url         : 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    encoding    : 'terrarium',
    zoom        : 11,
    maxZoom     : 17,
    tileSize    : 512,
    attribution : '© Mapterhorn (https://mapterhorn.com/attribution) · Copernicus GLO-30: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
  },
}
