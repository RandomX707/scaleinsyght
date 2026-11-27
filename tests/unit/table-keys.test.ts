import { expect, it } from 'vitest';
import { groupTableKeys } from '@scaleinsyght/connectors';

it('groups catalog index rows into one entry per table with its primary key', () => {
  expect(groupTableKeys([
    { table: 'dbo.orders', name: 'PK_orders', columns: ['order_id'], unique: true, primary: true },
    { table: 'dbo.orders', name: 'ix_orders_customer_day', columns: ['customer_id', 'ordered_on'], unique: false, primary: false },
    { table: 'dbo.customers', name: 'uq_customers_email', columns: ['email'], unique: true, primary: false },
  ])).toEqual([
    { table: 'dbo.orders', primaryKey: ['order_id'], indexes: [{ name: 'PK_orders', columns: ['order_id'], unique: true, primary: true }, { name: 'ix_orders_customer_day', columns: ['customer_id', 'ordered_on'], unique: false, primary: false }] },
    { table: 'dbo.customers', primaryKey: [], indexes: [{ name: 'uq_customers_email', columns: ['email'], unique: true, primary: false }] },
  ]);
});
