import { z } from 'zod';
import { checkoutRecordSchema, projectRecordSchema } from '../../contracts/project-context.js';
import {
  checkoutLocationSchema,
  registeredProjectSchema,
  registryCheckoutSchema,
  runBindingSchema,
  type RegisteredProject,
  type RegistryCheckout,
} from '../../contracts/projects.js';
import {
  stateAttemptSchema,
  stateJobSchema,
  stateRepositorySchema,
} from '../../contracts/state.js';
import type { ProjectRegistry } from '../../ports/project-registry.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';

function valid<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    return stateFailure('state_invalid_data');
  }

  return parsed.data;
}

export function createSqliteProjectRegistry(db: StateDatabase): ProjectRegistry {
  const project = (id: string): RegisteredProject | null => {
    const row = db
      .statement(`SELECT p.data AS project_data, r.data AS repository_data, g.registered_at
      FROM projects p JOIN checkouts c ON c.id=p.primary_checkout_id
      JOIN repositories r ON r.id=c.repository_id
      LEFT JOIN project_registrations g ON g.project_id=p.id WHERE p.id=?`)
      .get(id);

    return row
      ? valid(registeredProjectSchema, {
          project: db.data(projectRecordSchema, { data: row.project_data }),
          repository: db.data(stateRepositorySchema, { data: row.repository_data }),
          registeredAt: row.registered_at,
        })
      : null;
  };

  const checkout = (sql: string, value: string): RegistryCheckout | null => {
    const row = db.statement(sql).get(value);

    return row
      ? valid(registryCheckoutSchema, {
          checkout: db.data(checkoutRecordSchema, row),
          registered: row.registered_id !== null,
          location:
            row.location === null ? null : db.data(checkoutLocationSchema, { data: row.location }),
        })
      : null;
  };

  const checkoutById = (id: string) =>
    checkout(
      `SELECT c.data, g.checkout_id AS registered_id, g.location FROM checkouts c
    LEFT JOIN registered_checkouts g ON g.checkout_id=c.id WHERE c.id=?`,
      id,
    );

  return {
    async readProject(id) {
      return db.read(() => project(id));
    },
    async readCheckout(id) {
      return db.read(() => checkoutById(id));
    },
    async findCheckout(rootPath) {
      return db.read(() =>
        checkout(
          `SELECT c.data, g.checkout_id AS registered_id, g.location FROM checkouts c
        LEFT JOIN registered_checkouts g ON g.checkout_id=c.id WHERE c.root_path=?`,
          rootPath,
        ),
      );
    },
    async findRepository(commonDirectory) {
      return db.read(() =>
        db.get(
          stateRepositorySchema,
          'SELECT data FROM repositories WHERE common_directory=?',
          commonDirectory,
        ),
      );
    },
    async findRegisteredProject(repositoryId) {
      return db.read(() => {
        const row = db
          .statement('SELECT project_id FROM project_registrations WHERE repository_id=?')
          .get(repositoryId);

        return row ? project(valid(z.string(), row.project_id)) : null;
      });
    },
    async readRun(id) {
      return db.read(() => {
        const row = db
          .statement(`SELECT a.data AS attempt_data, j.data AS job_data FROM attempts a
          JOIN jobs j ON j.id=a.job_id WHERE a.id=?`)
          .get(id);

        if (!row) {
          return null;
        }

        // Read through the existing record schemas before projecting the binding.
        const attempt = db.get(stateAttemptSchema, 'SELECT data FROM attempts WHERE id=?', id);
        const job = attempt
          ? db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', attempt.jobId)
          : null;

        return attempt && job
          ? valid(runBindingSchema, {
              id: attempt.id,
              jobId: job.id,
              projectId: job.projectId,
              repositoryId: job.repositoryId,
              checkoutId: job.checkoutId,
              branch: attempt.branch,
              commit: attempt.commit,
            })
          : stateFailure('state_invalid_data');
      });
    },
    register(request) {
      return db.write(() => {
        const { repository, project: selectedProject, checkout: selectedCheckout } = request;
        const existingRepository = db.get(
          stateRepositorySchema,
          'SELECT data FROM repositories WHERE id=?',
          repository.id,
        );
        const existingProject = db.get(
          projectRecordSchema,
          'SELECT data FROM projects WHERE id=?',
          selectedProject.id,
        );
        const existingCheckout = db.get(
          checkoutRecordSchema,
          'SELECT data FROM checkouts WHERE id=?',
          selectedCheckout.id,
        );

        if (
          (existingRepository && canonicalJson(existingRepository) !== canonicalJson(repository)) ||
          (existingProject && canonicalJson(existingProject) !== canonicalJson(selectedProject)) ||
          (existingCheckout && canonicalJson(existingCheckout) !== canonicalJson(selectedCheckout))
        ) {
          stateFailure('project_registration_conflict');
        }

        if (!existingRepository) {
          db.statement('INSERT INTO repositories(id, common_directory, data) VALUES (?, ?, ?)').run(
            repository.id,
            repository.commonDirectory,
            canonicalJson(repository),
          );
        }

        if (!existingProject) {
          db.statement('INSERT INTO projects(id, primary_checkout_id, data) VALUES (?, ?, ?)').run(
            selectedProject.id,
            selectedProject.primaryCheckoutId,
            canonicalJson(selectedProject),
          );
        }

        if (!existingCheckout) {
          db.statement(
            'INSERT INTO checkouts(id, project_id, repository_id, root_path, data) VALUES (?, ?, ?, ?, ?)',
          ).run(
            selectedCheckout.id,
            selectedCheckout.projectId,
            selectedCheckout.repositoryId,
            selectedCheckout.rootPath,
            canonicalJson(selectedCheckout),
          );
        }

        const previousProject = db
          .statement(
            'SELECT registered_at, repository_id FROM project_registrations WHERE project_id=?',
          )
          .get(selectedProject.id);
        const previousCheckout = db
          .statement('SELECT registered_at, location FROM registered_checkouts WHERE checkout_id=?')
          .get(selectedCheckout.id);

        if (
          previousCheckout &&
          canonicalJson(db.data(checkoutLocationSchema, { data: previousCheckout.location })) !==
            canonicalJson(request.location)
        ) {
          stateFailure('project_checkout_stale');
        }

        if (previousProject && previousProject.repository_id !== repository.id) {
          stateFailure('project_registration_conflict');
        }

        if (!previousProject) {
          db.statement(
            'INSERT INTO project_registrations(project_id, repository_id, registered_at) VALUES (?, ?, ?)',
          ).run(selectedProject.id, repository.id, request.projectRegisteredAt);
        }

        if (!previousCheckout) {
          db.statement(
            'INSERT INTO registered_checkouts(checkout_id, project_id, repository_id, registered_at, location) VALUES (?, ?, ?, ?, ?)',
          ).run(
            selectedCheckout.id,
            selectedProject.id,
            repository.id,
            request.checkoutRegisteredAt,
            canonicalJson(request.location),
          );
        }

        return {
          value: {
            ...request,
            projectRegisteredAt: previousProject
              ? valid(z.number().int().nonnegative(), previousProject.registered_at)
              : request.projectRegisteredAt,
            checkoutRegisteredAt: previousCheckout
              ? valid(z.number().int().nonnegative(), previousCheckout.registered_at)
              : request.checkoutRegisteredAt,
          },
          disposition: previousCheckout && previousProject ? 'existing' : 'created',
        };
      });
    },
    async list(request) {
      return db.read(() => {
        const rows = db
          .statement(
            'SELECT project_id FROM project_registrations WHERE project_id > ? ORDER BY project_id LIMIT ?',
          )
          .all(request.after ?? '', request.limit + 1);
        const items = rows.slice(0, request.limit).map((row) => {
          const entry =
            project(valid(z.string(), row.project_id)) ?? stateFailure('state_invalid_data');
          const primary = checkoutById(entry.project.primaryCheckoutId);

          if (!primary || !primary.registered) {
            return stateFailure('state_invalid_data');
          }

          return { project: entry, primaryCheckout: primary.checkout };
        });

        return {
          items,
          nextCursor:
            rows.length > request.limit ? (items.at(-1)?.project.project.id ?? null) : null,
        };
      });
    },
  };
}
