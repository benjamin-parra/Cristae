import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableEllipse extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['edit'] }

  static kind = 'ellipse'
}
