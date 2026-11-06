import { CristaeEditable } from './CristaeEditable.js'

export class CristaeEditableSector extends CristaeEditable {

  static cristaeSignature = { role: 'leaf', produces: ['edit'] }

  static kind = 'sector'
}
