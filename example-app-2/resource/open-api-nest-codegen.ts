import * as path from "path";
import {
  OpenAPIObject,
  PathObject,
  SchemaObject,
  OperationObject,
  ContentObject,
} from "openapi3-ts";
import { singular } from "pluralize";
import { pascalCase } from "pascal-case";
import { Module, interpolate, readCode } from "../module.util";
import { SchemaToDelegate, getSchemaToDelegate } from "../open-api-primsa";
import { resolveRef, groupByResource } from "../open-api.util";
import { PrismaClient } from "@prisma/client";
import flatten from "lodash.flatten";
import { createServiceModule } from "./service-codegen";
import { createControllerModule } from "./controller-codegen";
import { createResourceModule } from "./resource-module-codegen";

const serviceFindOneTemplatePath = require.resolve(
  "./templates/service/find-one.ts"
);
const serviceFindManyTemplatePath = require.resolve(
  "./templates/service/find-many.ts"
);
const serviceCreateTemplatePath = require.resolve(
  "./templates/service/create.ts"
);

const controllerFindOneTemplatePath = require.resolve(
  "./templates/controller/find-one.ts"
);
const controllerFindManyTemplatePath = require.resolve(
  "./templates/controller/find-many.ts"
);
const controllerCreateTemplatePath = require.resolve(
  "./templates/controller/create.ts"
);

enum HTTPMethod {
  get = "get",
  post = "post",
  patch = "patch",
  put = "put",
  delete = "delete",
}

export async function createResourcesModules(
  api: OpenAPIObject,
  prismaClient: PrismaClient
): Promise<Module[]> {
  const schemaToDelegate = getSchemaToDelegate(api, prismaClient);
  const byResource = groupByResource(api);
  const resourceModuleLists = await Promise.all(
    Object.entries(byResource).map(([resource, paths]) =>
      generateResource(api, resource, paths, schemaToDelegate)
    )
  );
  return flatten(resourceModuleLists);
}

async function generateResource(
  api: OpenAPIObject,
  resource: string,
  paths: PathObject,
  schemaToDelegate: SchemaObject
): Promise<Module[]> {
  const serviceMethods: string[] = [];
  const controllerMethods: string[] = [];
  const entity = singular(resource);
  const entityType = pascalCase(entity);
  const entityDTOModulePath = path.join("dto", `${entityType}.ts`);
  const entityModulePath = path.join(entity, `${entity}.module.ts`);
  const entityServiceModulePath = path.join(entity, `${entity}.service.ts`);
  const entityControllerModulePath = path.join(
    entity,
    `${entity}.controller.ts`
  );
  for (const [path, pathSpec] of Object.entries(paths)) {
    for (const [method, operationSpec] of Object.entries(pathSpec)) {
      const { controllerMethod, serviceMethod } = await getHandler(
        api,
        entityType,
        method as HTTPMethod,
        path,
        operationSpec as OperationObject,
        schemaToDelegate
      );
      controllerMethods.push(controllerMethod);
      serviceMethods.push(serviceMethod);
    }
  }

  /** @todo move from definition */
  const serviceModule = await createServiceModule(
    entityServiceModulePath,
    entityType,
    entityDTOModulePath,
    serviceMethods
  );

  const controllerModule = await createControllerModule(
    entityControllerModulePath,
    entityType,
    entityDTOModulePath,
    entityServiceModulePath,
    controllerMethods
  );

  const resourceModule = await createResourceModule(
    entityModulePath,
    entityType,
    entityServiceModulePath,
    entityControllerModulePath
  );

  return [serviceModule, controllerModule, resourceModule];
}

async function getHandler(
  api: OpenAPIObject,
  entityType: string,
  method: HTTPMethod,
  path: string,
  operation: OperationObject,
  schemaToDelegate: SchemaToDelegate
): Promise<{ serviceMethod: string; controllerMethod: string }> {
  if (!api?.components?.schemas) {
    throw new Error("api.components.schemas must be defined");
  }
  /** @todo handle deep paths */
  const [, , parameter] = getExpressVersion(path).split("/");
  switch (method) {
    case HTTPMethod.get: {
      /** @todo use path */
      const response = operation.responses["200"];
      const ref = getContentSchemaRef(response.content);
      const schema = resolveRef(api, ref) as SchemaObject;
      const delegate = schemaToDelegate[ref];
      if (!schema) {
        throw new Error(`Invalid ref: ${ref}`);
      }
      switch (schema.type) {
        case "object": {
          const serviceFindOneTemplate = await readCode(
            serviceFindOneTemplatePath
          );
          const controllerFindOneTemplate = await readCode(
            controllerFindOneTemplatePath
          );
          return {
            serviceMethod: interpolate(serviceFindOneTemplate, {
              DELEGATE: delegate,
              ENTITY: entityType,
            }),
            controllerMethod: interpolate(controllerFindOneTemplate, {
              COMMENT: operation.summary,
              ENTITY: entityType,
              PATH: parameter,
            }),
          };
        }
        case "array": {
          const serviceFindManyTemplate = await readCode(
            serviceFindManyTemplatePath
          );
          const controllerFindManyTemplate = await readCode(
            controllerFindManyTemplatePath
          );
          return {
            serviceMethod: interpolate(serviceFindManyTemplate, {
              DELEGATE: delegate,
              ENTITY: entityType,
            }),
            controllerMethod: interpolate(controllerFindManyTemplate, {
              COMMENT: operation.summary,
              ENTITY: entityType,
            }),
          };
        }
      }
    }
    case HTTPMethod.post: {
      if (operation.requestBody) {
        if (!("content" in operation.requestBody)) {
          throw new Error();
        }
        const ref = getContentSchemaRef(operation.requestBody.content);
        const delegate = schemaToDelegate[ref];
        const serviceCreateTemplate = await readCode(serviceCreateTemplatePath);
        const controllerCreateTemplate = await readCode(
          controllerCreateTemplatePath
        );
        return {
          serviceMethod: interpolate(serviceCreateTemplate, {
            DELEGATE: delegate,
            ENTITY: entityType,
          }),
          controllerMethod: interpolate(controllerCreateTemplate, {
            COMMENT: operation.summary,
            ENTITY: entityType,
          }),
        };
      }
    }
    default: {
      throw new Error(`Unknown method: ${method}`);
    }
  }
}

function getContentSchemaRef(content: ContentObject): string {
  const mediaType = content["application/json"];
  if (!mediaType.schema) {
    throw new Error("mediaType.schema must be defined");
  }
  return mediaType.schema["$ref"];
}

// Copied from https://github.com/isa-group/oas-tools/blob/5ee4506e4020671a11412d8d549da3e01c44c143/src/index.js
function getExpressVersion(oasPath: string): string {
  return oasPath.replace(/{/g, ":").replace(/}/g, "");
}
