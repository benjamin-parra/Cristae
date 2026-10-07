import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableSector extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'sector'
}
