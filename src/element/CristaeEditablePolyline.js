import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolyline extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'polyline'
}
