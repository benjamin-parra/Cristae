import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePoint extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'point'
}
