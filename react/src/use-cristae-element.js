import { useLayoutEffect, useRef } from 'react'
import { applyElementProps } from './apply-props.js'

// useCristaeElement — enlaza un custom element <cristae-*> a props React SIN reconciliar su contenido.
// React monta el elemento UNA vez; en cada render, un layout effect aplica las props con
// applyElementProps diffeando contra el render anterior (atributo / propiedad / evento). El DATO
// (source/data/accessors/iconSet) va por PROPIEDAD → el core reactivo del elemento maneja los updates
// (move/patch coalescido a rAF) fuera de React, sin re-render por tick. Devuelve el ref del elemento.
export function useCristaeElement(props, eventNameOf) {
  const ref = useRef(null)
  const applied = useRef({})
  useLayoutEffect(() => {
    if (ref.current) applied.current = applyElementProps(ref.current, applied.current, props, eventNameOf)
  })
  return ref
}
