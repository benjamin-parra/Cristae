import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolygon extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['polygon'], combine: null, arity: 'leaf' }

  static kind = 'polygon'
}
