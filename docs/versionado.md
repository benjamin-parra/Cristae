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

## Deprecación y retiro

Una API pública no se quita de un día para otro: primero se depreca, después se retira.

1. **Anuncio.** Al deprecarla, la API lleva `@deprecated` en los tipos con su reemplazo y la versión de
   retiro, una entrada en la sección «Deprecado» del CHANGELOG con su *Migración* y una fila en la tabla
   del README.
2. **Al menos una versión de aviso.** Entre la versión que la depreca y la que la retira sale como mínimo
   una versión publicada en la que la API sigue funcionando y su reemplazo ya existe.
3. **Retiro en una versión menor marcada.** Se retira en un minor (`0.y.0`), nunca en un patch. Ese minor
   se fija al anunciarlo, y su encabezado en el CHANGELOG dice que retira: cada API sale en la sección
   «Eliminado» con su *Migración*.

**El retiro vigente es v0.47.0**, el minor siguiente a la versión de la etapa C (el contexto WebGL
compartido). Retira todo lo que hoy está deprecado (la tabla del
[README](../README.md#deprecado-se-retira-en-v0470)). Los avisos de consola toman la versión de `RETIRO`, en
`src/engine/deprecated.js`.

Si antes del retiro entra otro cambio medio, el retiro se corre al minor siguiente y se corrigen los avisos,
el JSDoc y la documentación que lo nombran (inferido de la regla; falta que lo confirme el dueño).

## Emitir una versión

1. `git log --oneline <último tag>..main` y clasificar cada commit (medio / menor).
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
