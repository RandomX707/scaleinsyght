import { expect, it } from 'vitest';
import { nameSingleGroup } from '../../apps/worker/src/group-answer.js';

it('names the actual bottom group using its disclosed count', () => {
  expect(nameSingleGroup('The fewest orders was 25.',{group_value:'Rehabilitation',value:25},
    'Which department had the fewest orders?',{order:'asc',limit:1})).toBe('Rehabilitation had the fewest orders: 25.');
});
it('keeps the label without making an unsupported ranking claim', () => {
  expect(nameSingleGroup('There were 25 orders.',{group_value:'Ward 2',value:25},
    'Which department had the fewest orders?',{order:'desc',limit:1})).toBe('Ward 2: There were 25 orders.');
});
