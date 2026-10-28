import {
  ACTION_GROUPS,
  FormData,
  NodeConfig,
  FlowTypes,
  Features
} from '../types';
import { TransferAirtime, Node } from '../../store/flow-definition';
import { generateUUID, createSuccessFailureRouter } from '../../utils';
import { validateWith } from '../utils';
import { html } from 'lit';
import { msg, str } from '@lit/localize';
import { CURRENCY_OPTIONS, CURRENCIES } from '../currencies';
import { resultNameField } from './shared';

export const split_by_airtime: NodeConfig = {
  type: 'split_by_airtime',
  name: 'Send Airtime',
  subtitle:
    "Top up the contact's phone. The transfer completes in the background.",
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  features: [Features.AIRTIME],
  showAsAction: true,
  form: {
    amounts: {
      type: 'array',
      label: 'Airtime Amounts',
      helpText:
        "The contact receives the amount in their mobile network's currency.",
      required: true,
      itemLabel: 'Amount',
      sortable: false,
      minItems: 1,
      maxItems: 10,
      isEmptyItem: (item: any) => {
        return !item.currency || !item.amount || item.amount.trim() === '';
      },
      itemConfig: {
        currency: {
          type: 'select',
          placeholder: 'Select a currency',
          required: true,
          options: CURRENCY_OPTIONS,
          searchable: true,
          multi: false,
          width: '200px'
        },
        amount: {
          type: 'text',
          placeholder: 'Amount',
          required: true
        }
      }
    },
    result_name: resultNameField
  },
  layout: ['amounts', 'result_name'],
  validate: validateWith((formData, errors) => {
    if (!formData.amounts || !Array.isArray(formData.amounts)) {
      errors.amounts = msg('At least one currency and amount is required');
      return;
    }

    const validAmounts = formData.amounts.filter(
      (item: any) => item?.currency && item?.amount && item.amount.trim() !== ''
    );

    if (validAmounts.length === 0) {
      errors.amounts = msg('At least one currency and amount is required');
      return;
    }

    const currencies = new Set();
    const duplicates: string[] = [];

    validAmounts.forEach((item: any) => {
      const currencyCode =
        Array.isArray(item.currency) && item.currency.length > 0
          ? item.currency[0].value
          : typeof item.currency === 'string'
            ? item.currency
            : item.currency?.value;

      if (currencies.has(currencyCode)) {
        duplicates.push(currencyCode);
      } else {
        currencies.add(currencyCode);
      }
    });

    if (duplicates.length > 0) {
      errors.amounts = msg(
        str`Duplicate currencies found: ${duplicates.join(', ')}`
      );
      return;
    }

    for (const item of validAmounts) {
      const amount = item.amount.trim();
      if (isNaN(Number(amount)) || Number(amount) <= 0) {
        errors.amounts = msg('All amounts must be valid positive numbers');
        return;
      }
      // the engine caps amounts at 1e15
      if (Number(amount) > 1e15) {
        errors.amounts = msg('Amounts must be 1,000,000,000,000,000 or less');
        return;
      }
    }
  }),
  render: (node: Node) => {
    const transferAirtimeAction = node.actions?.find(
      (action) => action.type === 'transfer_airtime'
    ) as TransferAirtime;

    if (!transferAirtimeAction || !transferAirtimeAction.amounts) {
      return html`<div class="body">${msg('Configure airtime transfer')}</div>`;
    }

    const amounts = transferAirtimeAction.amounts;
    const currencies = Object.keys(amounts);

    if (currencies.length === 0) {
      return html`<div class="body">${msg('Configure airtime transfer')}</div>`;
    }

    // Display the first currency amount, with indicator if there are more
    const firstCurrency = currencies[0];
    const firstAmount = amounts[firstCurrency];
    const moreCount = currencies.length - 1;

    return html`
      <div class="body">
        ${firstCurrency}
        ${firstAmount}${moreCount > 0
          ? html` <span style="color: #999;"
              >${msg(str`+${moreCount} more`)}</span
            >`
          : ''}
      </div>
    `;
  },
  toFormData: (node: Node) => {
    // Extract data from the existing node structure
    const transferAirtimeAction = node.actions?.find(
      (action) => action.type === 'transfer_airtime'
    ) as TransferAirtime;

    const amounts: any[] = [];
    if (transferAirtimeAction && transferAirtimeAction.amounts) {
      Object.entries(transferAirtimeAction.amounts).forEach(
        ([currency, amount]) => {
          amounts.push({
            currency: [
              {
                value: currency,
                name: CURRENCIES[currency]?.name
                  ? `${CURRENCIES[currency].name} (${currency})`
                  : currency
              }
            ],
            amount: String(amount)
          });
        }
      );
    }

    return {
      uuid: node.uuid,
      amounts: amounts,
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get user amounts and convert to amounts object
    const amountsObject: Record<string, number> = {};

    if (formData.amounts && Array.isArray(formData.amounts)) {
      formData.amounts.forEach((item: any) => {
        if (!item?.currency || !item?.amount || item.amount.trim() === '') {
          return;
        }

        // Extract currency code from selection (handle both array and object formats)
        let currencyCode: string;
        if (Array.isArray(item.currency) && item.currency.length > 0) {
          currencyCode = item.currency[0].value;
        } else if (typeof item.currency === 'string') {
          currencyCode = item.currency;
        } else if (item.currency?.value) {
          currencyCode = item.currency.value;
        } else {
          return;
        }

        const amount = parseFloat(item.amount.trim());
        if (!isNaN(amount) && amount > 0) {
          amountsObject[currencyCode] = amount;
        }
      });
    }

    // Find existing transfer_airtime action to preserve its UUID
    const existingTransferAirtimeAction = originalNode.actions?.find(
      (action) => action.type === 'transfer_airtime'
    );
    const transferAirtimeUuid =
      existingTransferAirtimeAction?.uuid || generateUUID();

    // Create transfer_airtime action
    const transferAirtimeAction: TransferAirtime = {
      type: 'transfer_airtime',
      uuid: transferAirtimeUuid,
      amounts: amountsObject
    };

    // Create categories and exits for Success and Failure
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createSuccessFailureRouter(
      '@locals._new_transfer',
      {
        type: 'has_text',
        arguments: []
      },
      existingCategories,
      existingExits,
      existingCases
    );

    // Add result_name if provided
    const finalRouter: any = { ...router };
    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [transferAirtimeAction],
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
