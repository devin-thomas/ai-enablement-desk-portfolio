targetScope = 'resourceGroup'

type DeploymentSettings = {
  logAnalyticsWorkspaceName: string
  containerRegistryName: string
  containerEnvironmentName: string
  postgresServerName: string
  postgresAdministratorLogin: string
  postgresDatabaseName: string
  apiContainerAppName: string
  expiryJobName: string
  apiImageDigest: string
  geminiPublicLaunchApproved: bool
  fishVoicePreflightApproved: bool
  audioBriefingsEnabled: bool
  costActionGroupName: string
  alertEmailRecipients: string[]
  budgetName: string
  budgetAmount: 50
  budgetStartDate: string
  budgetEndDate: string
}

param location string
param settings DeploymentSettings

@secure()
param postgresAdministratorPassword string
@secure()
param databaseUrl string = ''
@secure()
param workspaceSigningKey string = ''
@secure()
param originSharedSecret string = ''
@secure()
param geminiApiKey string = ''
@secure()
param fishApiKey string = ''

@description('Enables image-dependent resources only after the private validation gate accepts an immutable digest.')
param deployWorkloads bool = false

var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: settings.logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 31
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: settings.containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
      retentionPolicy: {
        days: 7
        status: 'disabled'
      }
      exportPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: settings.containerEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: settings.postgresServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: settings.postgresAdministratorLogin
    administratorLoginPassword: postgresAdministratorPassword
    version: '16'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
      tenantId: ''
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: settings.postgresDatabaseName
  properties: {}
}

resource requireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
}

// Consumption Container Apps without a fixed egress IP need this temporary Azure-services exception.
resource allowAzureServicesTemporary 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgresServer
  name: 'allow-azure-services-temporary'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource apiContainerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployWorkloads) {
  name: settings.apiContainerAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: 'system'
        }
      ]
      secrets: concat([
        { name: 'database-url', value: databaseUrl }
        { name: 'workspace-signing-key', value: workspaceSigningKey }
        { name: 'origin-shared-secret', value: originSharedSecret }
      ], empty(geminiApiKey) ? [] : [
        { name: 'gemini-api-key', value: geminiApiKey }
      ], empty(fishApiKey) ? [] : [
        { name: 'fish-api-key', value: fishApiKey }
      ])
    }
    template: {
      containers: [
        {
          name: 'api'
          image: settings.apiImageDigest
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat([
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3001' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: 'false' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'WORKSPACE_COOKIE_SECRET', secretRef: 'workspace-signing-key' }
            { name: 'AZURE_ORIGIN_CREDENTIAL', secretRef: 'origin-shared-secret' }
            { name: 'GEMINI_PUBLIC_LAUNCH_APPROVED', value: settings.geminiPublicLaunchApproved ? 'true' : 'false' }
            { name: 'FISH_VOICE_PREFLIGHT_APPROVED', value: settings.fishVoicePreflightApproved ? 'true' : 'false' }
            { name: 'AUDIO_BRIEFINGS_ENABLED', value: settings.audioBriefingsEnabled ? 'true' : 'false' }
          ], empty(geminiApiKey) ? [] : [
            { name: 'GEMINI_API_KEY', secretRef: 'gemini-api-key' }
          ], empty(fishApiKey) ? [] : [
            { name: 'FISH_AUDIO_API_KEY', secretRef: 'fish-api-key' }
          ])
          probes: [
            { type: 'Startup', httpGet: { path: '/health/live', port: 3001 }, initialDelaySeconds: 5, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 24 }
            { type: 'Liveness', httpGet: { path: '/health/live', port: 3001 }, initialDelaySeconds: 15, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 3001 }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '25'
              }
            }
          }
        ]
      }
    }
  }
}

resource expiryJob 'Microsoft.App/jobs@2024-03-01' = if (deployWorkloads) {
  name: settings.expiryJobName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '17 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 300
      replicaRetryLimit: 1
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: 'system'
        }
      ]
      secrets: [
        { name: 'database-url', value: databaseUrl }
      ]
    }
    template: {
      containers: [
        {
          name: 'workspace-expiry'
          image: settings.apiImageDigest
          command: [
            'npm'
            'run'
            'workspaces:expire'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DEMO_MODE', value: 'false' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
          ]
        }
      ]
    }
  }
}

resource apiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWorkloads) {
  name: guid(containerRegistry.id, apiContainerApp!.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    principalId: apiContainerApp!.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleDefinitionId)
  }
}

resource expiryJobAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWorkloads) {
  name: guid(containerRegistry.id, expiryJob!.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    principalId: expiryJob!.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleDefinitionId)
  }
}

resource costActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: settings.costActionGroupName
  location: 'Global'
  properties: {
    enabled: true
    groupShortName: 'aiedeskcost'
    emailReceivers: [for (email, index) in settings.alertEmailRecipients: {
      name: 'cost-alert-${index}'
      emailAddress: email
      useCommonAlertSchema: true
    }]
  }
}

resource previewBudget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: settings.budgetName
  properties: {
    category: 'Cost'
    amount: settings.budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: settings.budgetStartDate
      endDate: settings.budgetEndDate
    }
    notifications: {
      actualCost40: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 40
        thresholdType: 'Actual'
        contactEmails: settings.alertEmailRecipients
        contactGroups: [
          costActionGroup.id
        ]
      }
      actualCost70: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 70
        thresholdType: 'Actual'
        contactEmails: settings.alertEmailRecipients
        contactGroups: [
          costActionGroup.id
        ]
      }
      actualCost90: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: settings.alertEmailRecipients
        contactGroups: [
          costActionGroup.id
        ]
      }
    }
  }
}

// Container Apps platform events are queried from the foundation's Log Analytics workspace.
resource acaReadinessRevisionRestartAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployWorkloads) {
  name: '${settings.apiContainerAppName}-readiness-revision-restarts'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'ACA readiness, revision, or restart failure'
    description: 'A Container Apps platform event indicates an unhealthy API revision.'
    severity: 1
    enabled: true
    skipQueryValidation: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [
      logAnalytics.id
    ]
    criteria: {
      allOf: [
        {
          query: 'ContainerAppSystemLogs_CL | where ContainerAppName_s == "${settings.apiContainerAppName}" | where Log_s has_any ("Readiness probe failed", "Revision failed", "restarted") | summarize failures = count()'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        costActionGroup.id
      ]
    }
  }
}

resource acaHttp5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployWorkloads) {
  name: '${settings.apiContainerAppName}-http-5xx'
  location: 'global'
  properties: {
    description: 'The API revision returned one or more HTTP 5xx responses.'
    severity: 1
    enabled: true
    scopes: [
      apiContainerApp.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.App/containerApps'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'http-5xx'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          timeAggregation: 'Total'
          operator: 'GreaterThan'
          threshold: 0
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'StatusCode'
              operator: 'Include'
              values: [
                '500'
                '501'
                '502'
                '503'
                '504'
              ]
            }
          ]
        }
      ]
    }
    actions: [
      {
        actionGroupId: costActionGroup.id
      }
    ]
  }
}

resource postgresCpuCreditsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${settings.postgresServerName}-cpu-credits-low'
  location: 'global'
  properties: {
    description: 'The burstable PostgreSQL server is approaching CPU-credit exhaustion.'
    severity: 2
    enabled: true
    scopes: [
      postgresServer.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    targetResourceType: 'Microsoft.DBforPostgreSQL/flexibleServers'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'cpu-credits-remaining'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'cpu_credits_remaining'
          timeAggregation: 'Average'
          operator: 'LessThan'
          threshold: 10
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: costActionGroup.id
      }
    ]
  }
}

resource postgresFailedConnectionsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${settings.postgresServerName}-failed-connections'
  location: 'global'
  properties: {
    description: 'PostgreSQL reported failed client connections.'
    severity: 2
    enabled: true
    scopes: [
      postgresServer.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    targetResourceType: 'Microsoft.DBforPostgreSQL/flexibleServers'
    targetResourceRegion: location
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failed-connections'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'connections_failed'
          timeAggregation: 'Total'
          operator: 'GreaterThan'
          threshold: 0
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: costActionGroup.id
      }
    ]
  }
}
