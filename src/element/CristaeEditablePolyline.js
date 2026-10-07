import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolyline extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['line'], combine: null, arity: 'leaf' }

  static kind = 'polyline'
}
