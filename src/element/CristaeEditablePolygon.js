import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditablePolygon extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['polygon'] }

  static kind = 'polygon'
}
