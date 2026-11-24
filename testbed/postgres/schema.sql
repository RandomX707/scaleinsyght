DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE departments (
  department_id integer PRIMARY KEY,
  department_code text NOT NULL UNIQUE,
  department_name text NOT NULL
);
CREATE TABLE providers (
  provider_id integer PRIMARY KEY,
  department_id integer NOT NULL,
  provider_name text NOT NULL,
  specialty text NOT NULL
);
CREATE TABLE patients (
  patient_id integer PRIMARY KEY,
  name text NOT NULL,
  date_of_birth date NOT NULL,
  mrn text NOT NULL UNIQUE,
  phone text,
  created_at timestamptz NOT NULL
);
CREATE TABLE encounters (
  encounter_id integer PRIMARY KEY,
  patient_id integer NOT NULL,
  department_id integer NOT NULL,
  provider_id integer NOT NULL,
  admitted_at timestamptz NOT NULL,
  discharged_at timestamptz
);
CREATE TABLE orders (
  order_id integer PRIMARY KEY,
  encounter_id integer NOT NULL REFERENCES encounters(encounter_id),
  department_id integer NOT NULL REFERENCES departments(department_id),
  order_type text NOT NULL,
  order_status text NOT NULL,
  ordered_at timestamptz NOT NULL,
  amount numeric(9,2) NOT NULL
);

CREATE VIEW patient_encounter_summary AS
SELECT p.patient_id, count(e.encounter_id)::integer AS encounter_count
FROM patients p LEFT JOIN encounters e USING (patient_id)
GROUP BY p.patient_id;
CREATE VIEW department_order_summary AS
SELECT d.department_id, count(o.order_id)::integer AS order_count, coalesce(sum(o.amount), 0)::numeric(12,2) AS order_amount
FROM departments d LEFT JOIN orders o USING (department_id)
GROUP BY d.department_id;

CREATE FUNCTION count_patient_encounters(p_patient_id integer)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM encounters WHERE patient_id = p_patient_id
$$;
CREATE FUNCTION patient_order_total(p_patient_id integer)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(o.amount), 0) FROM orders o JOIN encounters e USING (encounter_id) WHERE e.patient_id = p_patient_id
$$;

COMMENT ON COLUMN patients.name IS 'sensitivity:personal';
COMMENT ON COLUMN patients.date_of_birth IS 'sensitivity:regulated';
COMMENT ON COLUMN patients.mrn IS 'sensitivity:identifier';
COMMENT ON COLUMN patients.phone IS 'sensitivity:personal';
COMMENT ON COLUMN encounters.patient_id IS 'sensitivity:identifier';
COMMENT ON COLUMN encounters.encounter_id IS 'sensitivity:identifier';
COMMENT ON COLUMN orders.encounter_id IS 'sensitivity:identifier';

GRANT USAGE ON SCHEMA public TO si_testbed_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO si_testbed_reader;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO si_testbed_reader;
