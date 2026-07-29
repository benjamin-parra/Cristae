# AGENTS.md — Cristae

Estas instrucciones aplican a todo el repositorio.

## Antes de modificar código

- El código fuente es JavaScript ESM y vive principalmente en `src/`.
- Si el cambio afecta arquitectura o contratos públicos, leer primero `MODELO.md` y `SPECS.md`.
- Preservar los hot paths `[0-alloc]` documentados en `SPECS.md`: una simplificación sintáctica no
  justifica introducir arrays, objetos o clausuras nuevas por iteración.
- No modificar cambios ajenos presentes en el working tree.

## Estilo JavaScript: sintaxis mínima

La forma preferida es la expresión equivalente más corta, siempre que conserve el contrato,
el orden de evaluación, el receptor de `this` y la identidad de las funciones.

### Alineación en corridas

En una corrida de dos o más líneas consecutivas del mismo tipo, los valores quedan en columna.
Aplica a declaraciones sucesivas, literales de objeto, miembros de interface y alias de tipo.

La columna es la **mínima**: la fija el nombre más largo de la corrida. Se admite un espacio antes
del operador (preferido), pero no relleno de más.

```js
const cx   = size / 2
const tipY = size / 2                // la punta marca el punto
const r    = size * 0.2

static properties = {
  focusIds : { attribute: 'focus-ids' },
  pane     : {},
  z        : { type: Number },
}
```

Un bloque usa UNA sola forma: si el nombre más largo lleva espacio antes del operador, lo llevan
todos. Mezclarlas —el más largo pegado y el resto separado— es el error típico:

```js
focusIds: { attribute: 'focus-ids' },   // ✗ pegado
pane    : {},                           // ✗ separado, en el mismo bloque
```

Una línea suelta no se alinea con nada, y los parámetros de una firma multilínea tampoco son una
corrida (son argumentos, no una tabla). Un comentario intercalado NO la corta. Los índices de firma
(`[k: string]: unknown`) quedan fuera de la tabla. Al agregar una entrada que estira la columna, se
re-alinea la corrida entera.

### Arrow functions

- Omitir los paréntesis cuando existe un único parámetro identificador:

  ```js
  items.map(item => item.id)
  ```

- Usar cuerpo conciso cuando el bloque sólo devuelve una expresión:

  ```js
  const idOf = item => item.id
  ```

  No escribir `item => { return item.id }`.

- Preferir arrow functions sobre funciones anónimas. Una arrow no recibe un `this` dinámico: si el
  callback depende del receptor, capturarlo explícitamente o ligar la función original.

### Guards y retornos

- Un guard simple con un único efecto se expresa con cortocircuito booleano:

  ```js
  const schedule = () => pending && requestFrame()
  ```

  No escribir `() => { if (pending) requestFrame() }`. Aplicar esta forma cuando el valor devuelto
  (`false` o el resultado del efecto) sea compatible con el contrato de la función.

- Si el operando podría ser `undefined` y el guard debe devolver `false` de forma explícita,
  normalizarlo con doble negación:

  ```js
  const pick = () => !!this.#picking && this.#picking.request()
  ```

- Dos retornos mutuamente excluyentes se expresan con ternario:

  ```js
  return ready ? renderReady() : renderPending()
  ```

  No escribir `if (ready) return renderReady(); return renderPending()`.

- Los métodos públicos deben devolver el resultado útil de la operación que delegan cuando hacerlo
  permite al consumidor confirmar el resultado o encadenar la llamada. No descartar el retorno sin
  una razón contractual.

### Booleanos y valores por defecto

- Normalizar los booleanos en la frontera donde entran al objeto: parámetros por defecto, setters o
  construcción del registro. Después usar la propiedad directamente.

  ```js
  setVisible(visible = true) {
    this.visible = visible
    return this.#applyVisibility()
  }
  ```

- Evitar comprobaciones implícitas como `value !== false` cuando `undefined` sólo significa el valor
  por defecto. Expresar ese default una vez con `=`, `??` o `??=` según corresponda.
- Usar `!!value` cuando se necesita coerción booleana real; no usarla si el valor original forma
  parte del contrato.
- Preferir `??=`, `||=` y optional chaining cuando sean semánticamente equivalentes. No intercambiar
  `??` y `||`: cero, cadena vacía y `false` pueden ser valores válidos.

### `this`, `bind` y `call`

- Si una función original siempre debe ejecutarse con la misma instancia y no hace falta conservar
  su identidad para restaurarla, ligar el receptor una sola vez:

  ```js
  const original = target.method.bind(target)
  target.method = (...args) => enabled && original(...args)
  ```

- Mantener la referencia original sin ligar y usar `original.call(target, ...args)` cuando:
  - el receptor pueda variar;
  - la función exacta deba restaurarse posteriormente;
  - la identidad original sea parte del teardown o de una comparación.
- No cambiar una `function` por una arrow sin resolver antes su `this` dinámico.

### ASI y líneas que comienzan con accessors

El proyecto omite punto y coma normalmente. Al eliminar bloques o retornos, revisar siempre la
siguiente línea: si comienza con `[` —o con otro token que JavaScript pueda anexar a la expresión
anterior, como `(` o un template literal— anteponer un punto y coma.

```js
const values = getValues()
;[first, second] = values
```

No confiar en ASI en esos límites.

### Colecciones e iteración

- Preferir la operación de colección que exprese la intención sobre un `for` genérico:
  - `forEach` para ejecutar una acción o mutar estado local *in place*, sin construir un array nuevo;
  - `map` para una transformación uno-a-uno cuyo array resultante sí se necesita;
  - `filter` para producir un subconjunto que sí se conservará;
  - `reduce` para condensar la colección en un único acumulador;
  - `some` para «existe alguno» y corte temprano;
  - `every` para «todos cumplen» y corte temprano (`every` es el equivalente nativo de `all` en
    JavaScript).
- No usar `map`, `filter` o `reduce` sólo por apariencia funcional si crean resultados intermedios
  que no se necesitan. Para efectos o edición localizada, usar `forEach` y mutar el objeto poseído
  localmente.
- No simular un corte de `forEach` con flags o excepciones. Elegir `some`, `every`, `find` o
  `findIndex` según la intención y aprovechar su cortocircuito.
- Preferir mutación localizada de objetos y acumuladores propios sobre copias repetidas con spread.
  La mutación debe quedar confinada al bloque que posee el estado; no mutar entradas públicas,
  snapshots compartidos ni objetos cuya identidad sea parte de un contrato reactivo.
- Evitar handles y resultados temporales de un solo uso cuando se puede actualizar el estado
  poseído directamente. Conservar una variable local sólo si nombra una decisión de dominio, evita
  repetir una operación o hace visible una frontera semántica.

Las rutas marcadas `[0-alloc]` siguen siendo la excepción contractual: `map` y `filter` asignan
arrays, y una lambda local puede crear una clausura por invocación del método contenedor. En esas
rutas sólo usar un combinador si su callback ya es estable y no introduce basura; mantener un bucle
explícito cuando sea la única forma verificable de cumplir `[0-alloc]`.

### Llaves y bloques de control

- Omitir llaves en `if`, `else`, `for`, `for…of`, `while` y estructuras equivalentes cuando el cuerpo
  sea una única sentencia simple y la indentación resulte inequívoca:

  ```js
  if (!ready) return

  while (queue.length)
    flush(queue.pop())
  ```

- Mantener las llaves si el cuerpo contiene más de una sentencia, declaraciones relacionadas,
  comentarios internos o condicionales anidados que vuelvan ambiguo el `else`.
- No comprimir varias acciones independientes en una expresión con comas sólo para eliminar un
  bloque. La reducción de llaves debe mejorar la lectura, no ocultar secuencia o efectos.

### Pipeline local y división de lógica

Dentro de una función, ordenar el flujo como:

1. **Guards** — descartar primero los casos que no continúan.
2. **Declaración** — calcular y nombrar únicamente los datos necesarios.
3. **Acción** — mutar, emitir o devolver el resultado.

Evitar alternar validaciones, declaraciones y efectos si pueden agruparse naturalmente en ese orden.

Cuando una operación repetida sea demasiado grande para quedar legible dentro del combinador, usar
*named pipelining*: declarar una lambda local con nombre, junto al estado que captura, y entregarla al
bucle.

```js
const updateVisible = item => {
  if (!item.visible) return

  const target = registry.get(item.id)
  target && updateInPlace(target, item)
}

items.forEach(updateVisible)
```

El bloque anterior privilegia la lectura por etapas, pero no obliga a conservar esa estructura. Si
el pipeline completo sigue siendo claro como una sola expresión, es válido colapsar el guard, la
declaración localizada y la acción:

```js
const updateVisible = item =>
  item.visible &&
  (target => target && updateInPlace(target, item))(registry.get(item.id))
```

La condición es `item.visible`, no `!item.visible`: la forma concisa debe conservar exactamente qué
rama ejecutaba la versión expandida. Esta lambda inline permite nombrar el resultado de
`registry.get` sin repetir la búsqueda ni mantener un handle fuera de la expresión.

Preferir la versión colapsada cuando elimina estructura accidental sin esconder el orden de
evaluación. Mantener el bloque expandido cuando haya varias declaraciones, más de una acción,
comentarios necesarios o una condición cuya lectura se vuelva críptica al encadenarla.

Esta división permanece dentro de la función dueña. No extraer un bloque de un solo uso a una función
libre, método privado o archivo auxiliar sólo para acortar visualmente su call-site: eso fragmenta el
flujo y aumenta la superficie de mantenimiento. Extraerlo únicamente cuando exista reutilización
real, un contrato independiente o una responsabilidad de dominio que justifique una API propia.

En una ruta `[0-alloc]`, no crear la lambda local ni la lambda inline en cada ejecución: mantener el
bloque directo o usar un callback estable ya existente.

## Validación

Desde la raíz:

```bash
npm run lint
npm test
npm run build
```

El cambio no está cerrado hasta que pasen las validaciones aplicables. Si falla una comprobación por
un problema preexistente y ajeno al cambio, documentarlo expresamente.
