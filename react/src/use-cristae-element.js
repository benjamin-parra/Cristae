import { useLayoutEffect, useRef } from 'react'
import { applyElementProps, detachElementListeners } from './apply-props.js'

// useCristaeElement — enlaza un custom element <cristae-*> a props React SIN reconciliar su contenido.
// React monta el elemento UNA vez; en cada render, un layout effect aplica las props con
// applyElementProps diffeando contra el render anterior (atributo / propiedad / evento). El DATO
// (source/data/accessors/iconSet) va por PROPIEDAD → el core reactivo del elemento maneja los updates
// (move/patch coalescido a rAF) fuera de React, sin re-render por tick. Devuelve el ref del elemento.
export function useCristaeElement(props, eventNameOf) {
  const ref = useRef(null)
  const applied = useRef({})
  // Por render: aplica/difea las props sobre el elemento. Sin cleanup — el diff del PRÓXIMO render ya
  // da de baja lo que se fue; no hay que remover-y-re-agregar todo por render (churn + rompe el diff).
  useLayoutEffect(() => {
    if (ref.current) applied.current = applyElementProps(ref.current, applied.current, props, eventNameOf)
  })
  // Sólo al desmontar: desengancha los listeners aplicados. El elemento se captura en el montaje (el
  // ref ya está enlazado en el primer commit) y el closure lo conserva, así el teardown no depende de
  // que `ref.current` siga vivo cuando React lo anula. `eventNameOf` es estable (const de módulo).
  useLayoutEffect(() => {
    const el = ref.current
    return () => { if (el) detachElementListeners(el, applied.current, eventNameOf) }
  }, [])
  return ref
}
