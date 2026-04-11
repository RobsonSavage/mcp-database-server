// The 'mssql/msnodesqlv8' entry is an alternate driver path from the mssql package,
// loaded dynamically when a connection requests Windows integrated authentication.
// It exposes the same public surface as the default mssql entry, so alias the types.
declare module 'mssql/msnodesqlv8' {
  import mssql from 'mssql';
  export = mssql;
}
