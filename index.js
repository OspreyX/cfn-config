var _ = require('underscore');
var inquirer = require('inquirer');
var fs = require('fs');
var path = require('path');
var AWS = require('aws-sdk');
var ursa = require('ursa');
var env = {};

var config = module.exports;

// Allow override of the default superenv credentials
config.setCredentials = function (accessKeyId, secretAccessKey) {
    env.accessKeyId = accessKeyId;
    env.secretAccessKey = secretAccessKey;
};

// Run configuration wizard on a CFN template.
config.configure = function(template, stackname, region, overrides, callback) {
    var params = _(template.Parameters).map(_(config.question).partial(overrides));
    inquirer.prompt(params, function(answers) {
        callback(null, {
            StackName: stackname,
            Region: region,
            Parameters: answers
        });
    });
};

// Return a inquirer-compatible question object for a given CFN template
// parameter.
config.question = function(overrides, parameter, key) {
    function encryptInput(value) {
        if (!env.secureKey) return value.toString();
        var secure = ursa.createPrivateKey(fs.readFileSync(env.secureKey));
        return ['secure', secure.encrypt(value, 'utf8', 'base64')].join('::');
    }

    var question = {
        name: key,
        message: key + '. ' + parameter.Description || key,
        filter: parameter.NoEcho === 'true' ? encryptInput : function(value) { return value.toString() }
    };
    if ('Default' in parameter) question.default = parameter.Default;
    if (key in overrides.defaults) question.default = overrides.defaults[key];
    if (key in overrides.choices) question.choices = overrides.choices[key];
    if (key in overrides.messages) question.message = overrides.messages[key];
    if (key in overrides.filters) question.filter = overrides.filters[key];

    question.type = (function() {
        if (parameter.NoEcho === 'true') return 'password';
        if (parameter.AllowedValues) return 'list';
        return 'input';
    })();

    question.choices = parameter.AllowedValues;

    return question;
};

config.readTemplate = function(filepath, callback) {
    readJsonFile('template', filepath, callback);
}

config.readConfiguration = function (filepath, callback) {
    readJsonFile('configuration', filepath, function (err, configuration) {
        if (err) return callback(err);

        if (env.secureKey) {
            var secure = ursa.createPrivateKey(fs.readFileSync(env.secureKey));
            configuration.Parameters = _(configuration.Parameters).reduce(function (memo, value, key) {
                if (value.indexOf('secure::') === 0) {
                    memo[key] = secure.decrypt(value.replace('secure::', ''), 'base64', 'utf8');
                } else {
                    memo[key] = value;
                }
                return memo;
            }, {});
        }

        callback(null, configuration);
    });
}

config.readStackParameters = function(stackname, region, callback) {
    var cfn = new AWS.CloudFormation(_(env).extend({
        region: region
    }));

    cfn.describeStacks({StackName: stackname}, function (err, data) {
        if (err) return callback(err);
        if (data.Stacks.length < 1) return callback(new Error('Stack ' + stackname + ' not found'));

        var params = data.Stacks[0].Parameters.reduce(function (memo, param) {
            memo[param.ParameterKey] = param.ParameterValue;
            return memo;
        }, {});

        callback(null, params);
    });
}

config.writeConfiguration = function(filepath, config, callback) {
    var filepath = path.resolve(path.join(filepath, config.StackName + '.cfn.json'));
    var json = JSON.stringify(config, null, 4);

    console.log('Stack configuration:\n%s', json);

    confirmAction('Okay to write this configuration to ' + filepath + '?', function(confirm) {
        if (!confirm) return callback();
        fs.writeFile(filepath, json, callback);
    });
};

// Reusable function for determining configuration
//
// `options` object should include:
// - template: Required. Path to the Cloudformation template
// - region: The AWS region to deploy into
// - name: Required. Name of the Cloudformation stack
// - config: Optional. Path to a configuration file to use
// - update: Defaults to false. Reads existing stack parameters.
// - defaults, choices, messages, filters: Optional. Any of these properties can be
//   set to an object where the keys are Cloudformation parameter names, and the
//   values are as described by https://github.com/SBoudrias/Inquirer.js#question
//
//   Prioritization of defaults written by multiple processes follows:
//   1. Values set by parameters in an existing Cloudformation stack
//   2. Values set by higher-level libs (i.e. passed into this function as options.defaults)
//   3. Values set by a configuration file
//   4. Values set by the Cloudformation template
config.configStack = function(options, callback) {
    options.defaults = options.defaults || {};
    config.readTemplate(options.template, function(err, template) {
        if (err) return callback(err);

        if (!options.config) return afterFileLoad({});
        config.readConfiguration(options.config, function(err, configuration) {
            if (err) return callback(err);
            afterFileLoad(configuration.Parameters);
        });

        function afterFileLoad(fileParameters) {
            if (!options.update) return afterStackLoad(fileParameters, {});
            config.readStackParameters(options.name, options.region, function(err, stackParameters) {
                if (err) return callback(err);

                // Exclude masked stack parameters that come from the CFN API.
                stackParameters = _(stackParameters).reject(function(param, key) {
                    return template.Parameters[key].NoEcho === 'true';
                });

                afterStackLoad(fileParameters, stackParameters);
            });
        }

        function afterStackLoad(fileParameters, stackParameters) {

            var overrides = {
                defaults: _(stackParameters).chain()
                    .defaults(fileParameters)
                    .defaults(options.defaults)
                    .defaults(_(template.Parameters).reduce(function(memo, value, key) {
                        memo[key] = value.Default;
                        return memo;
                    }, {})).value(),
                choices: options.choices || {},
                filters: options.filters || {},
                messages: options.messages || {}
            };

            config.configure(template, options.name, options.region, overrides, function(err, configuration) {
                if (err) return callback(err);
                config.writeConfiguration('', configuration, function(err, aborted) {
                    if (err) return callback(err);
                    callback(null, {template: template, configuration: configuration});
                });
            });
        }

    });
};

config.createStack = function(options, callback) {
    // `options` object should include
    // - template: Required. Path to the Cloudformation template
    // - region: The AWS region to deploy into
    // - name: Required. Name of the Cloudformation stack
    // - config: Optional. Path to a configuration file to use
    // - iam: Defaults to false. Allows stack to create IAM resources

    var cfn = new AWS.CloudFormation(_(env).extend({
        region: options.region
    }));

    config.configStack(options, function (err, configDetails) {
        if (err) return callback(err);

        confirmAction('Ready to create this stack?', function (confirm) {
            if (!confirm) return callback();
            cfn.createStack({
                StackName: options.name,
                TemplateBody: JSON.stringify(configDetails.template, null, 4),
                Parameters: _(configDetails.configuration.Parameters).map(function(value, key) {
                    return {
                        ParameterKey: key,
                        ParameterValue: value
                    };
                }),
                Capabilities: options.iam ? [ 'CAPABILITY_IAM' ] : []
            }, callback);
        });
    });
};

config.updateStack = function(options, callback) {
    // Same options as createStack above.

    var cfn = new AWS.CloudFormation(_(env).extend({
        region: options.region
    }));

    options.update = true;
    config.configStack(options, function(err, configDetails) {
        if (err) return callback(err);

        confirmAction('Ready to update the stack?', function (confirm) {
            if (!confirm) return callback();
            cfn.updateStack({
                StackName: options.name,
                TemplateBody: JSON.stringify(configDetails.template, null, 4),
                Parameters: _(configDetails.configuration.Parameters).map(function(value, key) {
                    return {
                        ParameterKey: key,
                        ParameterValue: value
                    };
                }),
                Capabilities: options.iam ? [ 'CAPABILITY_IAM' ] : []
            }, callback);
        });
    });
}

config.deleteStack = function(options, callback) {
    // `options` object should include
    // - name: Required. Name of the Cloudformation stack
    // - region: The AWS region to deploy into
    var cfn = new AWS.CloudFormation(_(env).extend({
        region: options.region
    }));

    confirmAction('Ready to delete the stack ' + options.name + '?', function (confirm) {
        if (!confirm) return callback();
        cfn.deleteStack({
            StackName: options.name
        }, callback);
    })
};

config.stackInfo = function(options, callback) {
    // `options` object should include
    // - name: Required. Name of the Cloudformation stack
    // - region: The AWS region to deploy into
    // - resources: Defaults to false. Gets information about resources in the stack
    var cfn = new AWS.CloudFormation(_(env).extend({
        region: options.region
    }));

    cfn.describeStacks({ StackName: options.name }, function(err, data) {
        if (err) return callback(err);
        if (data.Stacks.length < 1) return callback(new Error('Stack ' + stackname + ' not found'));
        var stackInfo = data.Stacks[0];

        stackInfo.Parameters = stackInfo.Parameters.reduce(function(memo, param) {
            memo[param.ParameterKey] = param.ParameterValue;
            return memo;
        }, {});

        stackInfo.Outputs = stackInfo.Outputs.reduce(function(memo, output) {
            memo[output.OutputKey] = output.OutputValue;
            return memo;
        }, {});

        if (!options.resources) return callback(null, stackInfo);

        cfn.describeStackResources({ StackName: options.name }, function(err, data) {
            data = data || {};
            callback(err, _(stackInfo).extend(data));
        });
    });
}

function readJsonFile(filelabel, filepath, callback) {
    if (!filepath) return callback(new Error(filelabel + ' file is required'));

    fs.readFile(path.resolve(filepath), function(err, data) {
        if (err) {
            if (err.code === 'ENOENT') return callback(new Error('No such ' + filelabel + ' file'));
            return callback(err);
        }
        try {
            var jsonData = JSON.parse(data);
        } catch(e) {
            if (e.name === 'SyntaxError') return callback(new Error('Unable to parse ' + filelabel + ' file'));
            return callback(e);
        }
        callback(null, jsonData);
    });
}

function confirmAction(message, callback) {
    inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: message,
        default: true
    }], function(answers) {
        callback(answers.confirm);
    });
}
