import { expect } from '@open-wc/testing';
import { ContentList } from '../src/list/ContentList';
import { getComponent } from './utils.test';

const DEFAULT_LABELS = {
  'temba-campaign-list': ['Archive'],
  'temba-contact-list': ['Send', 'Start flow', 'Group', 'Archive', 'Delete'],
  'temba-flow-list': ['Label', 'Export results', 'Archive'],
  'temba-msg-list': ['Label', 'Archive', 'Delete'],
  'temba-trigger-list': ['Archive']
};

describe('content list default bulk actions', () => {
  for (const [tag, expected] of Object.entries(DEFAULT_LABELS)) {
    it(`${tag} reads its labels as it renders`, async () => {
      const list = (await getComponent(tag)) as ContentList<any>;

      expect(list.bulkActions.map((action) => action.label)).to.deep.equal(
        expected
      );

      // each label is a getter over msg(), so it's looked up in the current locale whenever the toolbar renders
      // rather than fixed to whatever locale was loaded when the list was constructed
      for (const action of list.bulkActions) {
        const descriptor = Object.getOwnPropertyDescriptor(action, 'label');
        expect(descriptor.get, action.key).to.be.a('function');
      }
    });
  }
});
