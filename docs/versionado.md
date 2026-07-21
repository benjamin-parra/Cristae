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
- **Cambio mayor** — rompe la API pública. En `0.x` no se emite: se acumula hasta el salto a `1.0.0`.

Un commit vale por su efecto sobre la API, no por su tamaño en líneas: un `fix` de 400 líneas sigue
siendo menor, y un `feat` de 20 que agrega un eje declarativo es medio.

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
