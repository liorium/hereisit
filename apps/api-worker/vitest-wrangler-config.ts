interface ContainerConfiguration {
  readonly class_name: string;
  readonly [key: string]: unknown;
}

interface DurableObjectBinding {
  readonly class_name: string;
  readonly [key: string]: unknown;
}

interface DurableObjectMigration {
  readonly tag: string;
  readonly new_classes?: readonly string[];
  readonly new_sqlite_classes?: readonly string[];
  readonly renamed_classes?: readonly { readonly from: string; readonly to: string }[];
  readonly deleted_classes?: readonly string[];
}

interface WranglerConfiguration {
  readonly containers?: readonly ContainerConfiguration[];
  readonly durable_objects?: {
    readonly bindings: readonly DurableObjectBinding[];
    readonly [key: string]: unknown;
  };
  readonly migrations?: readonly DurableObjectMigration[];
  readonly [key: string]: unknown;
}

function filterMigration(
  migration: DurableObjectMigration,
  containerClasses: ReadonlySet<string>,
): DurableObjectMigration | null {
  const operationKeys = [
    "new_classes",
    "new_sqlite_classes",
    "renamed_classes",
    "deleted_classes",
  ] as const;
  const hadOperations = operationKeys.some((key) => Array.isArray(migration[key]));
  const filtered: DurableObjectMigration = {
    ...migration,
    ...(migration.new_classes === undefined
      ? {}
      : { new_classes: migration.new_classes.filter((name) => !containerClasses.has(name)) }),
    ...(migration.new_sqlite_classes === undefined
      ? {}
      : {
          new_sqlite_classes: migration.new_sqlite_classes.filter(
            (name) => !containerClasses.has(name),
          ),
        }),
    ...(migration.renamed_classes === undefined
      ? {}
      : {
          renamed_classes: migration.renamed_classes.filter(
            ({ from, to }) => !containerClasses.has(from) && !containerClasses.has(to),
          ),
        }),
    ...(migration.deleted_classes === undefined
      ? {}
      : {
          deleted_classes: migration.deleted_classes.filter((name) => !containerClasses.has(name)),
        }),
  };
  for (const key of operationKeys) {
    if (filtered[key]?.length === 0) delete filtered[key];
  }
  const hasOperations = operationKeys.some((key) => Array.isArray(filtered[key]));
  return hadOperations && !hasOperations ? null : filtered;
}

export function createVitestWranglerConfig(config: WranglerConfiguration): WranglerConfiguration {
  const containerClasses = new Set(config.containers?.map(({ class_name }) => class_name) ?? []);
  const { containers: _containers, ...result } = config;
  const bindings = config.durable_objects?.bindings.filter(
    ({ class_name }) => !containerClasses.has(class_name),
  );
  const migrations = config.migrations
    ?.map((migration) => filterMigration(migration, containerClasses))
    .filter((migration): migration is DurableObjectMigration => migration !== null);

  if (bindings?.length) {
    result.durable_objects = { ...config.durable_objects, bindings };
  } else {
    delete result.durable_objects;
  }
  if (migrations?.length) {
    result.migrations = migrations;
  } else {
    delete result.migrations;
  }
  return result;
}
