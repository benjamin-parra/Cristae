import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableCircle extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['edit'] }

  static kind = 'circle'
}
