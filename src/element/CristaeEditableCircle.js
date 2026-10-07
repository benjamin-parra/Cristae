import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableCircle extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'circle'
}
