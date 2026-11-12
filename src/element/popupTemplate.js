import { fieldReader } from '../data/fields.js'

// Contenido de un <cristae-popup> declarado con un <template> hijo. Cada nodo con `data-field="ruta"`
// recibe el valor del ítem como TEXTO (`textContent`): el dato nunca se interpreta como HTML ni se
// vuelca a un atributo. La ruta admite `.` para anidar; un ítem nulo o un campo ausente dan ''.
//
//   <cristae-popup for="flota">
//     <template><b data-field="patente"></b> <span data-field="conductor.nombre"></span></template>
//   </cristae-popup>

const FIELD_SELECTOR = '[data-field]'

// `readers` es el Map por nombre del popup que llama: se compila cada lector una vez, no por apertura.
export const fillTemplate = (template, item, readers = new Map()) => {
  const fragment = template.content.cloneNode(true)
  const nodes = fragment.querySelectorAll(FIELD_SELECTOR)
  for (let i = 0; i < nodes.length; i++) {
    const name = nodes[i].getAttribute('data-field')
    let read = readers.get(name)
    if (!read) readers.set(name, read = fieldReader(name, 'text'))
    nodes[i].textContent = read(item)
  }
  return fragment
}
