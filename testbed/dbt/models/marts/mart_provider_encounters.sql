select p.provider_id, p.provider_name, p.specialty, count(e.encounter_id) as encounter_count
from {{ ref('stg_encounters') }} e
join {{ source('hospital', 'providers') }} p on e.provider_id = p.provider_id
group by p.provider_id, p.provider_name, p.specialty
