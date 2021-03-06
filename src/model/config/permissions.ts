import { ASTNode } from 'graphql';
import { MessageLocation } from '../validation';

export interface PermissionsConfig {
    readonly permissionProfileNameAstNode?: ASTNode
    readonly permissionProfileName?: string
    readonly roles?: RolesSpecifierConfig
}

export interface RolesSpecifierConfig {
    readonly astNode?: ASTNode
    readonly read?: ReadonlyArray<string>
    readonly readWrite?: ReadonlyArray<string>
}

export interface NamespacedPermissionProfileConfigMap {
    readonly namespacePath?: ReadonlyArray<string>
    readonly profiles: PermissionProfileConfigMap
}

export type PermissionAccessKind = 'read' | 'readWrite';

export interface PermissionProfileConfig {
    readonly permissions: ReadonlyArray<PermissionConfig>
    readonly loc?: MessageLocation;
}

export type PermissionProfileConfigMap = { [name: string]: PermissionProfileConfig }

export interface PermissionConfig {
    /**
     * Roles this permission is granted to. May use wildcards
     */
    roles: ReadonlyArray<string>

    access: PermissionAccessKind

    /**
     * If specified, the permission is only granted for objects with certain access groups
     */
    restrictToAccessGroups?: ReadonlyArray<string>
}
