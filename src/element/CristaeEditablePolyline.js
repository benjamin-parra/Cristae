import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolyline extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['line'] }

  static kind = 'polyline'
}
