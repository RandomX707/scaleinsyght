select
    date_trunc('month', admitted_at)::date as encounter_month,
    department_id,
    count(*) as encounter_count
from {{ source('hospital', 'encounters') }}
group by 1, 2
