/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

module.exports = {
    StatusError: class extends Error {
        constructor (message, statusCode) {
            super(message);
            this.statusCode = statusCode;
            this.message = message;
        }
    }
}