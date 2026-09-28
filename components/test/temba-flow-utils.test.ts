import { expect } from '@open-wc/testing';
import { zustand } from '../src/store/AppState';
import { shouldExcludeFlow, hasLLMRole } from '../src/flow/flow-utils';

function setFlowType(type: string) {
  const state = zustand.getState();
  zustand.setState({
    ...state,
    flowDefinition: {
      language: 'en',
      localization: {},
      name: 'Test Flow',
      nodes: [],
      uuid: 'test-uuid',
      type: type as any,
      revision: 1,
      spec_version: '14.3',
      _ui: { nodes: {}, languages: [] }
    }
  });
}

describe('shouldExcludeFlow', () => {
  it('allows message flows when current flow is messaging', () => {
    setFlowType('messaging');
    expect(shouldExcludeFlow({ type: 'message' })).to.be.false;
  });

  it('allows background flows when current flow is messaging', () => {
    setFlowType('messaging');
    expect(shouldExcludeFlow({ type: 'background' })).to.be.false;
  });

  it('excludes survey flows when current flow is messaging', () => {
    setFlowType('messaging');
    expect(shouldExcludeFlow({ type: 'survey' })).to.be.true;
  });

  it('excludes voice flows when current flow is messaging', () => {
    setFlowType('messaging');
    expect(shouldExcludeFlow({ type: 'voice' })).to.be.true;
  });

  it('excludes message flows when current flow is messaging_background', () => {
    setFlowType('messaging_background');
    expect(shouldExcludeFlow({ type: 'message' })).to.be.true;
  });

  it('allows background flows when current flow is messaging_background', () => {
    setFlowType('messaging_background');
    expect(shouldExcludeFlow({ type: 'background' })).to.be.false;
  });

  it('excludes survey flows when current flow is messaging_background', () => {
    setFlowType('messaging_background');
    expect(shouldExcludeFlow({ type: 'survey' })).to.be.true;
  });

  it('excludes voice flows when current flow is messaging_background', () => {
    setFlowType('messaging_background');
    expect(shouldExcludeFlow({ type: 'voice' })).to.be.true;
  });

  it('excludes message flows when current flow is messaging_offline', () => {
    setFlowType('messaging_offline');
    expect(shouldExcludeFlow({ type: 'message' })).to.be.true;
  });

  it('allows background flows when current flow is messaging_offline', () => {
    setFlowType('messaging_offline');
    expect(shouldExcludeFlow({ type: 'background' })).to.be.false;
  });

  it('allows survey flows when current flow is messaging_offline', () => {
    setFlowType('messaging_offline');
    expect(shouldExcludeFlow({ type: 'survey' })).to.be.false;
  });

  it('excludes voice flows when current flow is messaging_offline', () => {
    setFlowType('messaging_offline');
    expect(shouldExcludeFlow({ type: 'voice' })).to.be.true;
  });

  it('excludes message flows when current flow is voice', () => {
    setFlowType('voice');
    expect(shouldExcludeFlow({ type: 'message' })).to.be.true;
  });

  it('allows background flows when current flow is voice', () => {
    setFlowType('voice');
    expect(shouldExcludeFlow({ type: 'background' })).to.be.false;
  });

  it('excludes survey flows when current flow is voice', () => {
    setFlowType('voice');
    expect(shouldExcludeFlow({ type: 'survey' })).to.be.true;
  });

  it('allows voice flows when current flow is voice', () => {
    setFlowType('voice');
    expect(shouldExcludeFlow({ type: 'voice' })).to.be.false;
  });

  it('returns false when flow definition is null', () => {
    zustand.setState({ ...zustand.getState(), flowDefinition: null });
    expect(shouldExcludeFlow({ type: 'message' })).to.be.false;
  });

  it('returns false for unrecognized flow types', () => {
    setFlowType('messaging');
    expect(shouldExcludeFlow({ type: 'something_new' })).to.be.false;
    expect(shouldExcludeFlow({})).to.be.false;

    setFlowType('something_new');
    expect(shouldExcludeFlow({ type: 'voice' })).to.be.false;
  });
});

describe('hasLLMRole', () => {
  it('returns true when the model has the role', () => {
    expect(hasLLMRole({ roles: ['generation'] }, 'generation')).to.be.true;
    expect(hasLLMRole({ roles: ['translation', 'generation'] }, 'translation')).to.be.true;
  });

  it('returns false when the model lacks the role', () => {
    expect(hasLLMRole({ roles: ['translation'] }, 'generation')).to.be.false;
    expect(hasLLMRole({ roles: ['generation'] }, 'translation')).to.be.false;
    expect(hasLLMRole({ roles: [] }, 'generation')).to.be.false;
  });
});
