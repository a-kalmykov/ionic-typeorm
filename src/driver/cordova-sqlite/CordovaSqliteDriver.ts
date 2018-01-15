import {Driver} from "../Driver";
import {ConnectionIsNotSetError} from "../error/ConnectionIsNotSetError";
import {DriverOptions} from "../DriverOptions";
import {DatabaseConnection} from "../DatabaseConnection";
import {DriverUtils} from "../DriverUtils";
import {Logger} from "../../logger/Logger";
import {QueryRunner} from "../../query-runner/QueryRunner";
import {ColumnTypes} from "../../metadata/types/ColumnTypes";
import {ObjectLiteral} from "../../common/ObjectLiteral";
import {ColumnMetadata} from "../../metadata/ColumnMetadata";
import {DriverOptionNotSetError} from "../error/DriverOptionNotSetError";
import {DataTransformationUtils} from "../../util/DataTransformationUtils";
import {CordovaSqliteQueryRunner} from "./CordovaSqliteQueryRunner";
import {NamingStrategyInterface} from "../../naming-strategy/NamingStrategyInterface";

/**
 * Declare a global function that is only available on devices with the Cordova Sqlite Plugin.
 */
declare var window: any;

/**
 * Organizes communication with the Cordova Sqlite plugin.
 */
export class CordovaSqliteDriver implements Driver {

    // -------------------------------------------------------------------------
    // Public Properties
    // -------------------------------------------------------------------------

    /**
     * Naming strategy used in the connection where this driver is used.
     */
    namingStrategy: NamingStrategyInterface;

    /**
     * Driver connection options.
     */
    readonly options: DriverOptions;

    // -------------------------------------------------------------------------
    // Protected Properties
    // -------------------------------------------------------------------------

    /**
     * Connection to database.
     */
    protected databaseConnection: DatabaseConnection|undefined;

    /**
     * Logger used to log queries and errors.
     */
    protected logger: Logger;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(options: DriverOptions, logger: Logger) {

        this.options = DriverUtils.buildDriverOptions(options);
        this.logger = logger;

        // validate options to make sure everything is set
        // if (!this.options.host)
        //     throw new DriverOptionNotSetError("host");
        // if (!this.options.username)
        //     throw new DriverOptionNotSetError("username");
        if (!this.options.database)
            throw new DriverOptionNotSetError("database");
        // todo: what about extra options: version, description, size
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Performs connection to the database.
     * Based on pooling options, it can either create connection immediately,
     * either create a pool and create connection when needed.
     */
    connect(): Promise<void> {

        // build connection options for the driver
        const options = Object.assign({}, {
            database: this.options.database,
        }, this.options.extra || {});

        return new Promise<void>((ok, fail) => {
            (<any>window).sqlitePlugin.openDatabase({
                name: options.database + '.db',
                location: options.location || 'default',
            }, (connection: any) => {
                this.databaseConnection = {
                    id: 1,
                    connection: connection,
                    isTransactionActive: false
                };
                connection.run(`PRAGMA foreign_keys = ON;`, [], (result: any) => {
                    ok();
                }, fail);
            }, (error: any) => {
                fail(error);
            });
        });
    }

    /**
     * Closes connection with the database.
     */
    disconnect(): Promise<void> {
        if (!this.databaseConnection)
            throw new ConnectionIsNotSetError("cordova-sqlite");

        return new Promise<void>((ok, fail) => {
            // const handler = (err: any) => err ? fail(err) : ok();
            // todo: find out how to close connection
            ok();
        });
    }

    /**
     * Creates a query runner used for common queries.
     */
    async createQueryRunner(): Promise<QueryRunner> {
        if (!this.databaseConnection)
            return Promise.reject(new ConnectionIsNotSetError("cordova-sqlite"));

        const databaseConnection = await this.retrieveDatabaseConnection();
        return new CordovaSqliteQueryRunner(databaseConnection, this, this.logger);
    }

    /**
     * Access to the native implementation of the database.
     */
    nativeInterface() {
        return {
            connection: this.databaseConnection ? this.databaseConnection.connection : undefined
        };
    }

    /**
     * Replaces parameters in the given sql with special escaping character
     * and an array of parameter names to be passed to a query.
     */
    escapeQueryWithParameters(sql: string, parameters: ObjectLiteral): [string, any[]] {
        if (!parameters || !Object.keys(parameters).length)
            return [sql, []];
        const escapedParameters: any[] = [];
        const keys = Object.keys(parameters).map(parameter => "(:" + parameter + "\\b)").join("|");
        sql = sql.replace(new RegExp(keys, "g"), (key: string) => {
            escapedParameters.push(parameters[key.substr(1)]);
            return "?";
        }); // todo: make replace only in value statements, otherwise problems
        return [sql, escapedParameters];
    }

    /**
     * Escapes a column name.
     */
    escapeColumnName(columnName: string): string {
        return columnName; // "`" + columnName + "`";
    }

    /**
     * Escapes an alias.
     */
    escapeAliasName(aliasName: string): string {
        return aliasName; // "`" + aliasName + "`";
    }

    /**
     * Escapes a table name.
     */
    escapeTableName(tableName: string): string {
        return tableName; // "`" + tableName + "`";
    }

    /**
     * Prepares given value to a value to be persisted, based on its column type and metadata.
     */
    preparePersistentValue(value: any, columnMetadata: ColumnMetadata): any {
        if (value === null || value === undefined)
            return null;

        switch (columnMetadata.type) {
            case ColumnTypes.BOOLEAN:
                return value === true ? 1 : 0;

            case ColumnTypes.DATE:
                return DataTransformationUtils.mixedDateToDateString(value);

            case ColumnTypes.TIME:
                return DataTransformationUtils.mixedDateToTimeString(value);

            case ColumnTypes.DATETIME:
                if (columnMetadata.localTimezone) {
                    return DataTransformationUtils.mixedDateToDatetimeString(value);
                } else {
                    return DataTransformationUtils.mixedDateToUtcDatetimeString(value);
                }

            case ColumnTypes.JSON:
                return JSON.stringify(value);

            case ColumnTypes.SIMPLE_ARRAY:
                return DataTransformationUtils.simpleArrayToString(value);
        }

        return value;
    }

    /**
     * Prepares given value to a value to be persisted, based on its column type or metadata.
     */
    prepareHydratedValue(value: any, columnMetadata: ColumnMetadata): any {
        switch (columnMetadata.type) {
            case ColumnTypes.BOOLEAN:
                return value ? true : false;

            case ColumnTypes.DATETIME:
                return DataTransformationUtils.normalizeHydratedDate(value, columnMetadata.localTimezone === true, true);

            case ColumnTypes.TIME:
                return DataTransformationUtils.mixedTimeToString(value);

            case ColumnTypes.JSON:
                return JSON.parse(value);

            case ColumnTypes.SIMPLE_ARRAY:
                return DataTransformationUtils.stringToSimpleArray(value);
        }

        return value;
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Retrieves a new database connection.
     * If pooling is enabled then connection from the pool will be retrieved.
     * Otherwise active connection will be returned.
     */
    protected retrieveDatabaseConnection(): Promise<DatabaseConnection> {
        if (this.databaseConnection)
            return Promise.resolve(this.databaseConnection);

        throw new ConnectionIsNotSetError("cordova-sqlite");
    }

}
