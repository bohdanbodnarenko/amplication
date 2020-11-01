import React, { useMemo } from "react";
import { gql } from "@apollo/client";
import { useQuery } from "@apollo/client";
import {
  SelectField,
  Props as SelectFieldProps,
} from "../Components/SelectField";

type TEntities = {
  entities: [
    {
      id: string;
      displayName: string;
    }
  ];
};

type Props = Omit<SelectFieldProps, "options"> & {
  applicationId: string;
};

const EntitySelectField = ({ applicationId, ...props }: Props) => {
  const { data: entityList } = useQuery<TEntities>(GET_ENTITIES, {
    variables: {
      appId: applicationId,
    },
  });

  const entityListOptions = useMemo(() => {
    return entityList
      ? entityList.entities.map((entity) => ({
          value: entity.id,
          label: entity.displayName,
        }))
      : [];
  }, [entityList]);

  return <SelectField {...props} options={entityListOptions} />;
};

export default EntitySelectField;

export const GET_ENTITIES = gql`
  query getEntities($appId: String!) {
    entities(where: { app: { id: $appId } }) {
      id
      displayName
    }
  }
`;
