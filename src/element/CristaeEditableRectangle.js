import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableRectangle extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'rectangle'
}
