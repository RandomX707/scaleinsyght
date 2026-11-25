select order_id, encounter_id, department_id, order_type, order_status, ordered_at, amount
from {{ source('hospital', 'orders') }}
