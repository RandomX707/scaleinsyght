select o.order_id, o.department_id, o.amount as order_amount, c.claim_amount
from {{ ref('stg_orders') }} o
left join {{ source('billing', 'claims') }} c on c.order_id = o.order_id
