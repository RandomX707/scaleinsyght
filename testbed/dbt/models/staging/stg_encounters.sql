select encounter_id, department_id, provider_id, admitted_at, discharged_at
from {{ source('hospital', 'encounters') }}
