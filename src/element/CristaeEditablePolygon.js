import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolygon extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'polygon'
}
