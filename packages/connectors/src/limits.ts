/** Ceiling for catalog listings (tables, columns, keys, view and routine definitions): names only, sized for large
 * enterprise catalogs. Data reads keep their own, much lower row limit. */
export const CATALOG_ROW_LIMIT = 200_000;
