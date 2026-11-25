select d.department_id, d.department_name, count(o.order_id) as order_count, sum(o.amount) as order_amount
from {{ ref('stg_orders') }} o
join {{ source('hospital', 'departments') }} d on o.department_id = d.department_id
group by d.department_id, d.department_name
