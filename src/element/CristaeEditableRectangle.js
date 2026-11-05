import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableRectangle extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['edit'] }

  static kind = 'rectangle'
}
