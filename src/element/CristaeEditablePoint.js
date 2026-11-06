import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePoint extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['edit'] }

  static kind = 'point'
}
