# Versionado

Mientras Cristae siga en `0.x`, la versión se **deriva del historial**, no se elige a dedo:

```
v0.<cambios medios acumulados>.<cambios menores desde el último medio>
```

- **Cambio medio** — agrega una capacidad o un eje de API: una primitiva nueva (la capa de líneas, la
  capa HTML), un eje declarativo nuevo (`where`, `marked`, `enabled`, `scale`), una operación nueva del
  motor o de la gramática, la publicación de una superficie nueva (los tipos por entry). Suma 1 al
  **minor** y reinicia el **patch** a 0.
- **Cambio menor** — `fix`, `perf`, `revert`, ajuste de default, documentación con impacto. Suma 1 al
  **patch**.
- **Cambio mayor** — rompe la API pública. En `0.x` no sube el major: lo que rompe lleva su *Migración* en
  el CHANGELOG, y lo que se quita sigue el ciclo de [deprecación y retiro](#deprecación-y-retiro).

Un commit vale por su efecto sobre la API, no por su tamaño en líneas: un `fix` de 400 líneas sigue
siendo menor, y un `feat` de 20 que agrega un eje declarativo es medio.

Cuentan todos los commits desde el último tag, también los `fix` y los `docs` de código que todavía no se
publicó: un arreglo a algo que entró en la misma versión suma igual que uno a algo publicado. Una capacidad
que se arma en varios commits cuenta una vez, en el commit que la trae. No cuentan los tests, los ejemplos, el
`chore`, la documentación que acompaña a un commit que ya contó, ni las piezas internas que nada alcanza
hasta otro commit.

## Deprecación y retiro

Una API pública no se quita de un día para otro: primero se depreca, después se retira.

1. **Anuncio.** Al deprecarla, la API lleva `@deprecated` en los tipos con su reemplazo y la versión de
   retiro, una entrada en la sección «Deprecado» del CHANGELOG con su *Migración* y una fila en la tabla
   del README.
2. **Al menos una versión de aviso.** Entre la versión que la depreca y la que la retira sale como mínimo
   una versión publicada en la que la API sigue funcionando y su reemplazo ya existe.
3. **Retiro en una versión menor marcada.** Se retira en un minor (`0.y.0`), nunca en un patch: la versión
   que retira trae al menos un cambio medio. Su número es el que da la fórmula para esa versión, y su
   encabezado en el CHANGELOG dice que retira: cada API sale en la sección «Eliminado» con su *Migración*.

**El retiro vigente es v0.47.0.** Sale junto con `freeUnusedMemory()`, la operación del mapa y del control
del cluster que suelta la memoria sin uso: ese cambio medio es el que hace minor a la versión que retira. Con
un solo medio en esa versión, la fórmula da v0.47.0; si trae más, el número sube en la misma cantidad, y se
corrigen la constante `RETIRO` de `src/engine/deprecated.js`, de donde salen los avisos de consola, y el
JSDoc, los tipos y la documentación que lo nombran a mano. Retira todo lo que hoy está deprecado (la tabla
del [README](../README.md#deprecado-se-retira-en-v0470)).

## Emitir una versión

1. `git log --oneline <último tag>..main` y clasificar cada commit (medio, menor o no cuenta).
2. Calcular la versión con la fórmula de arriba.
3. `package.json` → `version`; `CHANGELOG.md` → cerrar `[Sin publicar]` con `## [x.y.z] - AAAA-MM-DD`.
4. Commit `chore(release): vx.y.z` + tag anotado `git tag -a vx.y.z -m "…"` + `git push origin main --follow-tags`.

## Consumo aguas abajo

Los consumidores que instalan desde GitHub apuntan al **tag**, no a `#main`:

```jsonc
"cristae": "github:benjamin-parra/Cristae#v0.13.0"
```

`#main` deja el consumidor expuesto a cualquier commit en curso: basta un `install` sin lockfile
congelado para arrastrar trabajo a medio terminar. El tag es el único punto estable.
