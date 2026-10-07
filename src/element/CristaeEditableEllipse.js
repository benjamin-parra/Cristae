import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableEllipse extends CristaeEditable {

  static cristaeSignature = { consumes: [], produces: ['edit'], combine: null, arity: 'leaf' }

  static kind = 'ellipse'
}
