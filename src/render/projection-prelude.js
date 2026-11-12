// El preludio GLSL de proyección: el contrato con que las capas calculan el clip de un punto sin saber qué
// proyección hay debajo. Hoy sólo existe la variante afín (`mercator`); el parámetro de la matriz se llama
// `fm` porque `flat` es palabra reservada en GLSL ES 3.00.
const MERCATOR = `
uniform float u_projection_scale;

vec4 projectRel(mat4 fm, vec2 rel) {
  return fm * vec4(rel, 0.0, 1.0);
}

vec3 projectScreen(mat4 fm, vec2 rel, vec2 px) {
  return vec3((fm * vec4(rel, 0.0, 1.0)).xy / px, 0.0);
}

float projectScale(vec2 rel) {
  return u_projection_scale;
}

bool projectHidden(vec4 c) {
  return false;
}
`

const VARIANTS = { mercator: MERCATOR }

const HEADER_LINE = /^\s*(#version\b|precision\b)/
const BLANK_OR_COMMENT = /^\s*(\/\/.*)?$/

// Inserta el preludio después de `#version` y de las líneas `precision` de la cabecera.
export const withProjection = (source, variant = 'mercator') => {
  const prelude = VARIANTS[variant]
  if (!prelude) throw new Error(`Variante de proyección desconocida: ${variant}`)
  const lines = source.split('\n')
  let end = 0
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_LINE.test(lines[i])) end = i + 1
    else if (!BLANK_OR_COMMENT.test(lines[i])) break
  }
  lines.splice(end, 0, prelude)
  return lines.join('\n')
}

// La clave de `sharedProgram`: el mismo fuente con otra variante es otro programa.
export const projectionKey = (base, variant) => `${base}:${variant}`
